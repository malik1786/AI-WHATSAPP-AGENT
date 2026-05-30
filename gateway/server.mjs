import express from "express";
import qrcodeTerminal from "qrcode-terminal";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT ?? "3001", 10);
const BACKEND_WEBHOOK_URL = process.env.BACKEND_WEBHOOK_URL ?? "http://127.0.0.1:5000/webhook";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? "";
const AUTH_PATH = process.env.WWEBJS_AUTH_PATH ?? ".wwebjs_auth";
const AUTH_DIR = path.resolve(AUTH_PATH);
const BACKEND_API_URL = (process.env.BACKEND_API_URL ?? "").replace(/\/$/, "");
const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend", "dist");
const MIN_DELAY_SAME_RECIPIENT_MS = parseInt(process.env.MIN_DELAY_SAME_RECIPIENT_MS ?? "3000", 10);
const RANDOM_SEND_DELAY_MIN_MS = parseInt(process.env.RANDOM_SEND_DELAY_MIN_MS ?? "2000", 10);
const RANDOM_SEND_DELAY_MAX_MS = parseInt(process.env.RANDOM_SEND_DELAY_MAX_MS ?? "8000", 10);

const app = express();
app.use(express.json({ limit: "1mb" }));

if (BACKEND_API_URL) {
  app.all("/api/*", async (req, res) => {
    try {
      const targetUrl = `${BACKEND_API_URL}${req.originalUrl}`;
      const headers = { ...req.headers, host: new URL(BACKEND_API_URL).host };
      delete headers["transfer-encoding"];
      const fetchOpts = { method: req.method, headers };
      if (req.method !== "GET" && req.method !== "HEAD") fetchOpts.body = JSON.stringify(req.body);
      const proxyRes = await fetch(targetUrl, fetchOpts);
      res.status(proxyRes.status);
      res.set("Content-Type", proxyRes.headers.get("content-type") || "application/json");
      res.send(Buffer.from(await proxyRes.arrayBuffer()));
    } catch (e) {
      console.error("[API PROXY] error:", e?.message ?? e);
      res.status(502).json({ error: "backend unavailable" });
    }
  });
}

if (fs.existsSync(FRONTEND_DIR)) app.use(express.static(FRONTEND_DIR));

function nowMs() { return Date.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function typingDurationMs(text) { return Math.max(1000, Math.ceil((text?.length ?? 0) / 10) * 1000); }

function requireToken(req, res, next) {
  if (!GATEWAY_TOKEN) return next();
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${GATEWAY_TOKEN}`) return res.status(401).json({ error: "unauthorized" });
  next();
}

let sock = null;
let lastQr = null;
let ready = false;
let authenticated = false;
let lastDisconnect = null;
let userInfo = null;
let connecting = false;
const lastSentAtByRecipient = new Map();

function clearAuthState(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log("[WA] Cleared auth state from", dir);
    }
  } catch (e) {
    console.error("[WA] Failed to clear auth state:", e?.message);
  }
}

async function postWebhook(payload) {
  try {
    const res = await fetch(BACKEND_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}) },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error("[WEBHOOK] backend returned", res.status, await res.text().catch(() => ""));
  } catch (e) {
    console.error("[WEBHOOK] failed:", e?.message ?? e);
  }
}

let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

async function connectToWhatsApp() {
  if (connecting) return;
  connecting = true;

  try {
    const authDir = AUTH_DIR;
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    console.log("[WA] Starting connection...", authDir);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const logger = pino({ level: "silent" });

    let version;
    try {
      const v = await fetchLatestBaileysVersion();
      version = v.version;
      console.log("[WA] Latest WA Web version:", version);
    } catch (e) {
      console.error("[WA] Failed to fetch WA version, using default:", e?.message);
    }

    sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      generateHighQualityLinkPreview: false,
      logger,
      getMessage: async () => undefined,
      ...(version ? { version } : {}),
    });

    sock.ev.on("creds.update", saveCreds);

    let connectTimeout = null;
    connectTimeout = setTimeout(() => {
      if (!ready && connecting) {
        console.log("[WA] Connection timed out after 30s in 'connecting' state — forcing reconnect");
        try { sock.end(undefined); } catch {}
        connecting = false;
        clearAuthState(authDir);
        reconnectAttempts++;
        setTimeout(connectToWhatsApp, 3000);
      }
    }, 30000);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect: ld, qr } = update;

      console.log("[WA] connection.update:", JSON.stringify({
        connection,
        hasQr: !!qr,
        ldKeys: ld ? Object.keys(ld) : null,
        ldErrorType: ld?.error?.constructor?.name ?? typeof ld?.error ?? "none",
        ldErrorMsg: ld?.error?.message ?? String(ld?.error ?? "none"),
        ldDate: ld?.date ?? "none",
      }));

      if (qr) {
        lastQr = qr;
        ready = false;
        reconnectAttempts = 0;
        if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
        console.log("\n[WA] QR received — scan with WhatsApp:");
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === "close") {
        ready = false;
        authenticated = false;
        if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }

        const err = ld?.error;
        const errorMsg = err?.message ?? String(err ?? "unknown");
        const statusCode = err?.output?.statusCode ?? err?.statusCode ?? null;
        lastDisconnect = { at: new Date().toISOString(), reason: errorMsg };

        console.log("[WA] Connection closed. error:", errorMsg, "statusCode:", statusCode, "errType:", err?.constructor?.name, "full:", JSON.stringify(err ?? "no error"));

        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isConnectionReplaced = statusCode === DisconnectReason.connectionReplaced;
        const isBadSession = statusCode === DisconnectReason.badSession;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;
        const isMultideviceMismatch = statusCode === 411;

        if (isLoggedOut || isBadSession || isMultideviceMismatch) {
          console.log("[WA] Clearing auth state (code:", statusCode, ")");
          clearAuthState(authDir);
        } else if (statusCode === undefined) {
          console.log("[WA] Network/connection error — keeping auth, will retry");
        }

        if (isLoggedOut || isConnectionReplaced) {
          console.log("[WA] Stopped — not reconnecting.");
          connecting = false;
          return;
        }

        reconnectAttempts++;
        const delay = isRestartRequired ? 1000 : Math.min(3000 * reconnectAttempts, MAX_RECONNECT_DELAY);
        console.log(`[WA] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
        setTimeout(() => { connecting = false; connectToWhatsApp(); }, delay);
      }

      if (connection === "open") {
        ready = true;
        authenticated = true;
        lastQr = null;
        userInfo = sock.user ?? null;
        reconnectAttempts = 0;
        connecting = false;
        if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
        console.log("[WA] Connected! User:", userInfo?.name ?? "unknown");
      }
    });

    sock.ev.on("messages.upsert", async (msg) => {
      if (msg.type !== "notify") return;
      for (const m of msg.messages) {
        if (!m || m.key.fromMe) continue;
        const from = m.key.remoteJid ?? "";
        const body = m.message?.conversation
          ?? m.message?.extendedTextMessage?.text
          ?? m.message?.buttonsResponseMessage?.selectedButtonId
          ?? m.message?.listResponseMessage?.singleSelectReply?.selectedRowId
          ?? "";
        const payload = {
          id: m.key.id ?? null,
          from,
          body,
          timestamp: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000).toISOString() : null,
          type: "text",
          isGroup: from.endsWith("@g.us"),
        };
        await sock.readMessages([m.key]).catch(() => {});
        await postWebhook(payload);
      }
    });

    connecting = false;
  } catch (e) {
    console.error("[WA] connectToWhatsApp crashed:", e?.message ?? e);
    connecting = false;
    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, MAX_RECONNECT_DELAY);
    console.log(`[WA] Retrying in ${delay}ms...`);
    setTimeout(connectToWhatsApp, delay);
  }
}

async function resetConnection() {
  ready = false;
  authenticated = false;
  lastQr = null;
  userInfo = null;
  if (sock) { try { sock.end(undefined); } catch {} sock = null; }
  clearAuthState(AUTH_DIR);
  reconnectAttempts = 0;
  connecting = false;
  await connectToWhatsApp();
}

app.get("/status", (_req, res) => {
  res.json({ ok: true, ready, authenticated, hasQr: !!lastQr, connecting, lastDisconnect, userInfo: userInfo ? { pushname: userInfo.name ?? null, phone: userInfo.id?.split(":")[0] ?? null } : null });
});

app.get("/qr", (_req, res) => {
  if (!lastQr) return res.status(404).json({ error: "no qr available" });
  res.json({ qr: lastQr });
});

app.post("/reset", requireToken, async (_req, res) => {
  try { await resetConnection(); res.json({ ok: true, message: "Connection reset." }); }
  catch (e) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

app.post("/send", requireToken, async (req, res) => {
  const to = String(req.body?.to ?? "").trim();
  const text = String(req.body?.text ?? "").trim();
  const simulateTyping = req.body?.simulateTyping !== false;
  if (!to || !text) return res.status(400).json({ error: "`to` and `text` are required" });
  if (!ready || !sock) return res.status(503).json({ error: "whatsapp client not ready (scan QR?)" });
  try {
    const last = lastSentAtByRecipient.get(to) ?? 0;
    const extraWait = Math.max(0, MIN_DELAY_SAME_RECIPIENT_MS - (nowMs() - last));
    if (extraWait > 0) await sleep(extraWait);
    const waitMs = Math.max(randInt(RANDOM_SEND_DELAY_MIN_MS, RANDOM_SEND_DELAY_MAX_MS), typingDurationMs(text));
    if (simulateTyping) { await sock.sendPresenceUpdate("composing", to); await sleep(waitMs); await sock.sendPresenceUpdate("paused", to); }
    else await sleep(randInt(RANDOM_SEND_DELAY_MIN_MS, RANDOM_SEND_DELAY_MAX_MS));
    const sent = await sock.sendMessage(to, { text });
    lastSentAtByRecipient.set(to, nowMs());
    res.json({ ok: true, messageId: sent?.key?.id ?? null, to });
  } catch (e) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

app.post("/logout", requireToken, async (_req, res) => {
  try { if (sock) await sock.logout(); } catch {}
  ready = false; authenticated = false; lastQr = null;
  clearAuthState(AUTH_DIR);
  res.json({ ok: true });
});

app.post("/pairing-code", requireToken, async (req, res) => {
  if (ready) return res.status(400).json({ error: "Already connected." });
  if (!sock) return res.status(503).json({ error: "WhatsApp client not initialized yet" });
  const phoneNumber = String(req.body?.phoneNumber ?? "").replace(/\D/g, "").trim();
  if (!phoneNumber || phoneNumber.length < 10) return res.status(400).json({ error: "Valid phone number with country code required" });
  try {
    console.log("[WA] Requesting pairing code for:", phoneNumber);
    const code = await sock.requestPairingCode(phoneNumber);
    console.log("[WA] Pairing code received:", code);
    res.json({ ok: true, code });
  } catch (e) {
    console.error("[WA] Pairing code error:", e?.message ?? e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/cancel-pairing", requireToken, (_req, res) => { res.json({ ok: true, message: "Pairing cancelled" }); });

app.get("/chats", requireToken, async (_req, res) => {
  if (!ready || !sock) return res.status(503).json({ error: "whatsapp client not ready" });
  try {
    const chats = await sock.store?.chats?.all() ?? [];
    const items = [];
    for (const c of chats) {
      const id = c.id ?? null;
      if (!id || typeof id !== "string" || id === "status@broadcast") continue;
      items.push({ id, name: c.name ?? c.id, isGroup: id.endsWith("@g.us"), lastMessage: c.lastMessage?.message ?? null, lastMessageAt: c.lastMessage?.timestamp ? new Date(Number(c.lastMessage.timestamp) * 1000).toISOString() : null });
    }
    res.json({ ok: true, chats: items });
  } catch (e) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

const API_ROUTES = ["/status", "/qr", "/send", "/logout", "/pairing-code", "/cancel-pairing", "/chats", "/reset"];
if (fs.existsSync(FRONTEND_DIR)) {
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/") || API_ROUTES.includes(req.path)) return res.status(404).json({ error: "not found" });
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });
} else {
  app.get("/", (_req, res) => { res.json({ ok: true, message: "Gateway running. Frontend not built." }); });
}

app.listen(GATEWAY_PORT, async () => {
  console.log(`[GATEWAY] listening on http://127.0.0.1:${GATEWAY_PORT}`);
  console.log(`[GATEWAY] webhook -> ${BACKEND_WEBHOOK_URL}`);
  if (BACKEND_API_URL) console.log(`[GATEWAY] api proxy -> ${BACKEND_API_URL}`);
  if (fs.existsSync(FRONTEND_DIR)) console.log(`[GATEWAY] serving frontend from ${FRONTEND_DIR}`);

  try {
    const r = await fetch("https://web.whatsapp.com", { method: "HEAD", signal: AbortSignal.timeout(10000) });
    console.log("[GATEWAY] WhatsApp reachable, status:", r.status);
  } catch (e) {
    console.error("[GATEWAY] WhatsApp UNREACHABLE:", e?.message ?? e);
  }

  connectToWhatsApp();
});
