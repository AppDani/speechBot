// מספר הסיפורים הטיפולי - שרת מקומי
// מפעילים עם:  node server.js   ואז נפתח הדפדפן בכתובת http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const CACHE = path.join(ROOT, "cache");
const CONFIG_PATH = path.join(ROOT, "config.json");
fs.mkdirSync(CACHE, { recursive: true });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".json": "application/json" };

// config.json is re-read on every request, so edits apply without a restart
function config() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch (e) { console.error("⚠️  לא הצלחתי לקרוא את config.json:", e.message); return {}; }
}
const isSet = v => typeof v === "string" && v.trim() !== "" && !/^PASTE|^הדביקי/i.test(v.trim());

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 200_000) { reject(new Error("too_large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { reject(new Error("bad_json")); } });
  });
}

async function handleStatus(res) {
  const c = config(), voices = {};
  for (const [name, id] of Object.entries(c.elevenlabs?.voices || {})) voices[name] = isSet(id);
  send(res, 200, { anthropic: isSet(c.anthropic?.apiKey), elevenlabs: isSet(c.elevenlabs?.apiKey), voices });
}

async function handleClaude(req, res) {
  const c = config();
  if (!isSet(c.anthropic?.apiKey)) return send(res, 400, { error: "no_anthropic_key" });
  const { prompt, maxTokens } = await readJson(req);
  if (typeof prompt !== "string" || !prompt) return send(res, 400, { error: "no_prompt" });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": c.anthropic.apiKey.trim(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: c.anthropic.model || "claude-sonnet-5-5", max_tokens: Math.min(+maxTokens || 2000, 8000),
      messages: [{ role: "user", content: prompt }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("Anthropic error", r.status, j?.error?.message || ""); return send(res, 502, { error: "anthropic_" + r.status, detail: j?.error?.message }); }
  send(res, 200, { text: (j.content || []).filter(b => b.type === "text").map(b => b.text).join("") });
}

async function handleTts(req, res) {
  const c = config(), el = c.elevenlabs || {};
  if (!isSet(el.apiKey)) return send(res, 400, { error: "no_elevenlabs_key" });
  const { text, character, speed } = await readJson(req);
  const voiceId = el.voices?.[character];
  if (!isSet(voiceId)) return send(res, 400, { error: "no_voice_for_character", detail: character });
  if (typeof text !== "string" || !text.trim() || text.length > 3000) return send(res, 400, { error: "bad_text" });
  const model = el.model || "eleven_v3";
  const sp = Math.min(1.2, Math.max(0.7, +speed || 1));
  const key = crypto.createHash("sha1").update([model, voiceId, sp, text].join("|")).digest("hex");
  const file = path.join(CACHE, key + ".mp3");
  if (fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), "audio/mpeg");

  const call = withSpeed => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId.trim())}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": el.apiKey.trim(), "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, ...(withSpeed && sp !== 1 ? { voice_settings: { speed: sp } } : {}) })
  });
  let r = await call(true);
  if (!r.ok && r.status === 400) r = await call(false); // some models don't accept a speed setting
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("ElevenLabs error", r.status, detail.slice(0, 300));
    return send(res, 502, { error: "elevenlabs_" + r.status, detail: detail.slice(0, 300) });
  }
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  send(res, 200, buf, "audio/mpeg");
}

function serveStatic(req, res) {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const target = path.normalize(path.join(PUBLIC, url === "/" ? "index.html" : url));
  if (!target.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
  fs.readFile(target, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain");
    send(res, 200, data, TYPES[path.extname(target).toLowerCase()] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/status") return await handleStatus(res);
    if (req.url === "/api/claude" && req.method === "POST") return await handleClaude(req, res);
    if (req.url === "/api/tts" && req.method === "POST") return await handleTts(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    send(res, 404, { error: "not_found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server_error", detail: e.message });
  }
});

const port = config().port || 3000;
server.listen(port, "127.0.0.1", () => {
  const url = `http://localhost:${port}`;
  const c = config();
  console.log(`\n📖 מספר הסיפורים פועל:  ${url}`);
  console.log(`   Anthropic (יצירת סיפורים): ${isSet(c.anthropic?.apiKey) ? "מחובר ✓" : "חסר מפתח ✗"}`);
  console.log(`   ElevenLabs (קולות):         ${isSet(c.elevenlabs?.apiKey) ? "מחובר ✓" : "חסר מפתח ✗"}`);
  console.log("   לעצירה: Ctrl+C\n");
  if (!process.env.NO_OPEN) exec((process.platform === "darwin" ? "open " : process.platform === "win32" ? "start " : "xdg-open ") + url);
});
