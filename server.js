// מספר הסיפורים הטיפולי - שרת מקומי
// מפעילים עם:  node server.js   ואז נפתח הדפדפן בכתובת http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(ROOT, "cache");
const CONFIG_PATH = path.join(ROOT, "config.json");
fs.mkdirSync(CACHE, { recursive: true });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".json": "application/json" };

// Settings come from config.json on your computer, or from environment variables on a host like Render.
// config.json is re-read on every request, so edits apply without a restart.
const VOICE_ENV = { "נועה": "VOICE_NOA", "דני": "VOICE_DANI", "אבי": "VOICE_AVI", "מאיה": "VOICE_MAYA", "יואב": "VOICE_YOAV" };
function config() {
  let c = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
    catch (e) { console.error("⚠️  לא הצלחתי לקרוא את config.json:", e.message); }
  }
  const env = process.env;
  c.anthropic = { ...(c.anthropic || {}) };
  c.elevenlabs = { ...(c.elevenlabs || {}), voices: { ...(c.elevenlabs?.voices || {}) } };
  if (env.ANTHROPIC_API_KEY) c.anthropic.apiKey = env.ANTHROPIC_API_KEY;
  if (env.ANTHROPIC_MODEL) c.anthropic.model = env.ANTHROPIC_MODEL;
  if (env.ELEVENLABS_API_KEY) c.elevenlabs.apiKey = env.ELEVENLABS_API_KEY;
  if (env.ELEVENLABS_MODEL) c.elevenlabs.model = env.ELEVENLABS_MODEL;
  for (const [name, key] of Object.entries(VOICE_ENV)) if (env[key]) c.elevenlabs.voices[name] = env[key];
  if (env.APP_PASSWORD) c.password = env.APP_PASSWORD;
  return c;
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

// Only the page and the character images are served. config.json, server.js and the cache stay private.
function serveStatic(req, res) {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const allowed = rel === "index.html" || /^img\/[\w.-]+\.(jpg|jpeg|png|svg)$/i.test(rel);
  const target = path.normalize(path.join(ROOT, rel));
  if (!allowed || !target.startsWith(ROOT)) return send(res, 404, "not found", "text/plain");
  fs.readFile(target, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain");
    send(res, 200, data, TYPES[path.extname(target).toLowerCase()] || "application/octet-stream");
  });
}

// Optional password: set "password" in config.json or APP_PASSWORD on the host.
// The browser asks for it once (any user name works) and remembers it.
function authorized(req) {
  const pw = config().password;
  if (!isSet(pw)) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  const a = Buffer.from(given), b = Buffer.from(pw);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="speechBot", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" });
      return res.end("נדרשת סיסמה");
    }
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

const onHost = !!process.env.PORT;            // Render and similar hosts set PORT
const port = +process.env.PORT || config().port || 3000;
server.listen(port, onHost ? "0.0.0.0" : "127.0.0.1", () => {
  const url = `http://localhost:${port}`;
  const c = config();
  console.log(`\n📖 מספר הסיפורים פועל:  ${onHost ? "port " + port : url}`);
  console.log(`   Anthropic (יצירת סיפורים): ${isSet(c.anthropic?.apiKey) ? "מחובר ✓" : "חסר מפתח ✗"}`);
  console.log(`   ElevenLabs (קולות):         ${isSet(c.elevenlabs?.apiKey) ? "מחובר ✓" : "חסר מפתח ✗"}`);
  console.log(`   סיסמה:                      ${isSet(c.password) ? "מוגדרת ✓" : "ללא"}`);
  if (onHost && !isSet(c.password)) console.warn("⚠️  האתר פתוח לכולם. הגדירו APP_PASSWORD בהגדרות השרת.");
  if (!onHost) console.log("   לעצירה: Ctrl+C\n");
  if (!onHost && !process.env.NO_OPEN) exec((process.platform === "darwin" ? "open " : process.platform === "win32" ? "start " : "xdg-open ") + url);
});
