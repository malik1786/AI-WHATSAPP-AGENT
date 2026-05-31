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
const BACKEND_WEBHOOK_URL = (() => {
  let url = process.env.BACKEND_WEBHOOK_URL ?? "http://127.0.0.1:5000/webhook";
  if (url.startsWith("//")) url = "https:" + url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
  return url;
})();
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? "";
const AUTH_BASE = process.env.WWEBJS_AUTH_PATH ?? "/tmp/wa_auth";
const BACKEND_API_URL = (process.env.BACKEND_API_URL ?? "").replace(/\/$/, "");
const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend", "dist");

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

const MIN_DELAY_SAME_RECIPIENT_MS = parseInt(process.env.MIN_DELAY_SAME_RECIPIENT_MS ?? "3000", 10);
const RANDOM_SEND_DELAY_MIN_MS = parseInt(process.env.RANDOM_SEND_DELAY_MIN_MS ?? "2000", 10);
const RANDOM_SEND_DELAY_MAX_MS = parseInt(process.env.RANDOM_SEND_DELAY_MAX_MS ?? "8000", 10);
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

// ── Multi-session manager ──────────────────────────────
const sessions = new Map();

function getSession(userId) {
  return sessions.get(userId) || null;
}

function getOrCreateSession(userId) {
  if (sessions.has(userId)) return sessions.get(userId);
  const s = {
    userId,
    sock: null,
    lastQr: null,
    ready: false,
    authenticated: false,
    connecting: false,
    lastDisconnect: null,
    userInfo: null,
    reconnectAttempts: 0,
    connectTimeout: null,
  };
  sessions.set(userId, s);
  return s;
}

async function connectUser(userId) {
  const s = getOrCreateSession(userId);
  if (s.connecting) return s;
  s.connecting = true;

  const authDir = path.join(AUTH_BASE, String(userId));
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  try {
    console.log(`[WA:${userId}] Starting connection...`);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const logger = pino({ level: "silent" });

    let version;
    try {
      const v = await fetchLatestBaileysVersion();
      version = v.version;
    } catch (e) {
      console.error(`[WA:${userId}] Failed to fetch WA version:`, e?.message);
    }

    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      generateHighQualityLinkPreview: false,
      logger,
      getMessage: async () => undefined,
      ...(version ? { version } : {}),
    });

    s.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    s.connectTimeout = setTimeout(() => {
      if (!s.ready && s.connecting) {
        console.log(`[WA:${userId}] Connection timed out`);
        try { sock.end(undefined); } catch {}
        s.connecting = false;
        clearAuthState(authDir);
        s.reconnectAttempts++;
        setTimeout(() => connectUser(userId), 3000);
      }
    }, 30000);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect: ld, qr } = update;

      if (qr) {
        s.lastQr = qr;
        s.ready = false;
        s.reconnectAttempts = 0;
        if (s.connectTimeout) { clearTimeout(s.connectTimeout); s.connectTimeout = null; }
        console.log(`[WA:${userId}] QR received`);
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === "close") {
        s.ready = false;
        s.authenticated = false;
        if (s.connectTimeout) { clearTimeout(s.connectTimeout); s.connectTimeout = null; }

        const err = ld?.error;
        const errorMsg = err?.message ?? String(err ?? "unknown");
        const statusCode = err?.output?.statusCode ?? err?.statusCode ?? null;
        s.lastDisconnect = { at: new Date().toISOString(), reason: errorMsg };

        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isConnectionReplaced = statusCode === DisconnectReason.connectionReplaced;
        const isBadSession = statusCode === DisconnectReason.badSession;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;
        const isMultideviceMismatch = statusCode === 411;

        if (isLoggedOut || isBadSession || isMultideviceMismatch) {
          console.log(`[WA:${userId}] Clearing auth state (code: ${statusCode})`);
          clearAuthState(authDir);
        }

        if (isLoggedOut || isConnectionReplaced) {
          console.log(`[WA:${userId}] Stopped — not reconnecting.`);
          s.connecting = false;
          return;
        }

        s.reconnectAttempts++;
        const delay = isRestartRequired ? 1000 : Math.min(3000 * s.reconnectAttempts, 30000);
        console.log(`[WA:${userId}] Reconnecting in ${delay}ms (attempt ${s.reconnectAttempts})...`);
        setTimeout(() => { s.connecting = false; connectUser(userId); }, delay);
      }

      if (connection === "open") {
        s.ready = true;
        s.authenticated = true;
        s.lastQr = null;
        s.userInfo = sock.user ?? null;
        s.reconnectAttempts = 0;
        s.connecting = false;
        if (s.connectTimeout) { clearTimeout(s.connectTimeout); s.connectTimeout = null; }
        console.log(`[WA:${userId}] Connected! User: ${s.userInfo?.name ?? "unknown"}`);
      }
    });

    sock.ev.on("messages.upsert", async (msg) => {
      if (msg.type !== "notify") return;
      for (const m of msg.messages) {
        if (!m || m.key.fromMe) continue;
        const from = m.key.remoteJid ?? "";
        const pushName = m.pushName ?? null;

        let resolvedFrom = from;
        if (from.endsWith("@lid")) {
          try {
            const storeContacts = Object.values(await sock.store?.contacts?.all?.() ?? []);
            const match = storeContacts.find(c => c.id === from);
            if (match?.notify) resolvedFrom = match.notify;
          } catch {}
        }

        const body = m.message?.conversation
          ?? m.message?.extendedTextMessage?.text
          ?? m.message?.buttonsResponseMessage?.selectedButtonId
          ?? m.message?.listResponseMessage?.singleSelectReply?.selectedRowId
          ?? "";

        const payload = {
          id: m.key.id ?? null,
          from: resolvedFrom,
          pushName,
          body,
          timestamp: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000).toISOString() : null,
          type: "text",
          isGroup: from.endsWith("@g.us"),
          userId,
        };

        await sock.readMessages([m.key]).catch(() => {});
        await postWebhook(payload);
      }
    });

    s.connecting = false;
  } catch (e) {
    console.error(`[WA:${userId}] connectToWhatsApp crashed:`, e?.message ?? e);
    s.connecting = false;
    s.reconnectAttempts++;
    const delay = Math.min(5000 * s.reconnectAttempts, 30000);
    setTimeout(() => connectUser(userId), delay);
  }

  return s;
}

async function disconnectUser(userId) {
  const s = sessions.get(userId);
  if (!s) return;
  try { s.sock?.end(undefined); } catch {}
  if (s.connectTimeout) clearTimeout(s.connectTimeout);
  const authDir = path.join(AUTH_BASE, String(userId));
  clearAuthState(authDir);
  sessions.delete(userId);
}

async function resetUser(userId) {
  await disconnectUser(userId);
  return connectUser(userId);
}

async function sendAsUser(userId, to, text, simulateTyping = true) {
  const s = sessions.get(userId);
  if (!s || !s.ready || !s.sock) throw new Error("whatsapp client not ready");
  const last = lastSentAtByRecipient.get(to) ?? 0;
  const extraWait = Math.max(0, MIN_DELAY_SAME_RECIPIENT_MS - (nowMs() - last));
  if (extraWait > 0) await sleep(extraWait);
  const waitMs = Math.max(randInt(RANDOM_SEND_DELAY_MIN_MS, RANDOM_SEND_DELAY_MAX_MS), typingDurationMs(text));
  if (simulateTyping) {
    await s.sock.sendPresenceUpdate("composing", to);
    await sleep(waitMs);
    await s.sock.sendPresenceUpdate("paused", to);
  } else {
    await sleep(randInt(RANDOM_SEND_DELAY_MIN_MS, RANDOM_SEND_DELAY_MAX_MS));
  }
  const sent = await s.sock.sendMessage(to, { text });
  lastSentAtByRecipient.set(to, nowMs());
  return { messageId: sent?.key?.id ?? null, to };
}

async function getChatsAsUser(userId) {
  const s = sessions.get(userId);
  if (!s || !s.ready || !s.sock) throw new Error("whatsapp client not ready");
  const chats = await s.sock.store?.chats?.all() ?? [];
  const items = [];
  for (const c of chats) {
    const id = c.id ?? null;
    if (!id || typeof id !== "string" || id === "status@broadcast") continue;
    items.push({ id, name: c.name ?? c.id, isGroup: id.endsWith("@g.us"), lastMessage: c.lastMessage?.message ?? null, lastMessageAt: c.lastMessage?.timestamp ? new Date(Number(c.lastMessage.timestamp) * 1000).toISOString() : null });
  }
  return items;
}

// ── API Routes ─────────────────────────────────────────

app.get("/status", requireToken, (req, res) => {
  const userId = req.query.userId || "default";
  const s = getSession(userId);
  if (!s) return res.json({ ok: true, ready: false, authenticated: false, hasQr: false, connecting: false, lastDisconnect: null, userInfo: null, sessions: sessions.size });
  res.json({
    ok: true,
    ready: s.ready,
    authenticated: s.authenticated,
    hasQr: !!s.lastQr,
    connecting: s.connecting,
    lastDisconnect: s.lastDisconnect,
    userInfo: s.userInfo ? { pushname: s.userInfo.name ?? null, phone: s.userInfo.id?.split(":")[0] ?? null } : null,
    sessions: sessions.size,
  });
});

app.get("/status-all", requireToken, (_req, res) => {
  const list = [];
  for (const [userId, s] of sessions) {
    list.push({ userId, ready: s.ready, authenticated: s.authenticated, phone: s.userInfo?.id?.split(":")[0] ?? null, name: s.userInfo?.name ?? null });
  }
  res.json({ ok: true, sessions: list, total: sessions.size });
});

app.get("/qr", requireToken, (req, res) => {
  const userId = req.query.userId || "default";
  const s = getSession(userId);
  if (!s?.lastQr) return res.status(404).json({ error: "no qr available" });
  res.json({ qr: s.lastQr });
});

app.post("/connect", requireToken, async (req, res) => {
  const userId = req.body?.userId || "default";
  try {
    const s = await connectUser(userId);
    res.json({ ok: true, ready: s.ready, hasQr: !!s.lastQr });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/disconnect", requireToken, async (req, res) => {
  const userId = req.body?.userId || "default";
  try {
    await disconnectUser(userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/reset", requireToken, async (req, res) => {
  const userId = req.body?.userId || "default";
  try {
    await resetUser(userId);
    res.json({ ok: true, message: "Connection reset." });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/send", requireToken, async (req, res) => {
  const userId = req.body?.userId || "default";
  const to = String(req.body?.to ?? "").trim();
  const text = String(req.body?.text ?? "").trim();
  const simulateTyping = req.body?.simulateTyping !== false;
  if (!to || !text) return res.status(400).json({ error: "`to` and `text` are required" });
  try {
    const result = await sendAsUser(userId, to, text, simulateTyping);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/chats", requireToken, async (req, res) => {
  const userId = req.query.userId || "default";
  try {
    const items = await getChatsAsUser(userId);
    res.json({ ok: true, chats: items });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/logout", requireToken, async (req, res) => {
  const userId = req.body?.userId || "default";
  const s = sessions.get(userId);
  if (s) {
    try { await s.sock?.logout(); } catch {}
    s.ready = false;
    s.authenticated = false;
    s.lastQr = null;
    const authDir = path.join(AUTH_BASE, String(userId));
    clearAuthState(authDir);
  }
  res.json({ ok: true });
});

app.post("/pairing-code", requireToken, async (req, res) => {
  const userId = req.body?.userId || "default";
  const s = sessions.get(userId);
  if (!s) return res.status(503).json({ error: "No session. Call /connect first." });
  if (s.ready) return res.status(400).json({ error: "Already connected." });
  if (!s.sock) return res.status(503).json({ error: "WhatsApp client not initialized yet" });
  const phoneNumber = String(req.body?.phoneNumber ?? "").replace(/\D/g, "").trim();
  if (!phoneNumber || phoneNumber.length < 10) return res.status(400).json({ error: "Valid phone number with country code required" });
  try {
    console.log(`[WA:${userId}] Requesting pairing code for:`, phoneNumber);
    const code = await s.sock.requestPairingCode(phoneNumber);
    console.log(`[WA:${userId}] Pairing code received:`, code);
    res.json({ ok: true, code });
  } catch (e) {
    console.error(`[WA:${userId}] Pairing code error:`, e?.message ?? e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/cancel-pairing", requireToken, (_req, res) => { res.json({ ok: true, message: "Pairing cancelled" }); });

// ── Legacy single-session endpoints (backward compat) ──
app.get("/legacy/status", requireToken, (_req, res) => {
  const s = getSession("default");
  if (!s) return res.json({ ok: true, ready: false, authenticated: false, hasQr: false });
  res.json({ ok: true, ready: s.ready, authenticated: s.authenticated, hasQr: !!s.lastQr, lastDisconnect: s.lastDisconnect, userInfo: s.userInfo ? { pushname: s.userInfo.name, phone: s.userInfo.id?.split(":")[0] } : null });
});

// ── Frontend catch-all ─────────────────────────────────
const API_ROUTES = ["/status", "/status-all", "/qr", "/send", "/logout", "/pairing-code", "/cancel-pairing", "/chats", "/reset", "/connect", "/disconnect", "/legacy/status"];
if (fs.existsSync(FRONTEND_DIR)) {
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/") || API_ROUTES.includes(req.path) || req.path.startsWith("/webhook")) return res.status(404).json({ error: "not found" });
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });
} else {
  app.get("/", (_req, res) => { res.json({ ok: true, message: "Gateway running. Frontend not built." }); });
}

// ── Start ──────────────────────────────────────────────
app.listen(GATEWAY_PORT, async () => {
  console.log(`[GATEWAY] listening on http://127.0.0.1:${GATEWAY_PORT}`);
  console.log(`[GATEWAY] webhook -> ${BACKEND_WEBHOOK_URL}`);
  console.log(`[GATEWAY] auth base -> ${AUTH_BASE}`);
  if (BACKEND_API_URL) console.log(`[GATEWAY] api proxy -> ${BACKEND_API_URL}`);
  if (fs.existsSync(FRONTEND_DIR)) console.log(`[GATEWAY] serving frontend from ${FRONTEND_DIR}`);

  try {
    const r = await fetch("https://web.whatsapp.com", { method: "HEAD", signal: AbortSignal.timeout(10000) });
    console.log("[GATEWAY] WhatsApp reachable, status:", r.status);
  } catch (e) {
    console.error("[GATEWAY] WhatsApp UNREACHABLE:", e?.message ?? e);
  }

  // Auto-connect default session for backward compat
  connectUser("default").catch(console.error);
});
