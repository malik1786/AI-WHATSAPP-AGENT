import express from "express";
import qrcodeTerminal from "qrcode-terminal";
import whatsappWeb from "whatsapp-web.js";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const { Client, LocalAuth } = whatsappWeb;

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT ?? "3001", 10);
const BACKEND_WEBHOOK_URL = process.env.BACKEND_WEBHOOK_URL ?? "http://127.0.0.1:5000/webhook";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? "";
const CLIENT_ID = process.env.WWEBJS_CLIENT_ID ?? "main";
const AUTH_PATH = process.env.WWEBJS_AUTH_PATH ?? ".wwebjs_auth";
const HEADLESS = (process.env.PUPPETEER_HEADLESS ?? "true").toLowerCase() !== "false";
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;

const MIN_DELAY_SAME_RECIPIENT_MS = parseInt(process.env.MIN_DELAY_SAME_RECIPIENT_MS ?? "3000", 10);
const RANDOM_SEND_DELAY_MIN_MS = parseInt(process.env.RANDOM_SEND_DELAY_MIN_MS ?? "2000", 10);
const RANDOM_SEND_DELAY_MAX_MS = parseInt(process.env.RANDOM_SEND_DELAY_MAX_MS ?? "8000", 10);

const app = express();
app.use(express.json({ limit: "1mb" }));

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function typingDurationMs(text) {
  // Roughly ~1s per 10 chars, with a small minimum.
  const base = Math.max(1000, Math.ceil((text?.length ?? 0) / 10) * 1000);
  return base;
}

function requireToken(req, res, next) {
  if (!GATEWAY_TOKEN) return next();
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${GATEWAY_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

let lastQr = null;
let ready = false;
let authenticated = false;
let lastDisconnect = null;
let lastQrAt = 0;

const lastSentAtByRecipient = new Map();

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: CLIENT_ID,
    dataPath: AUTH_PATH,
  }),
  puppeteer: {
    headless: HEADLESS,
    executablePath: PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--no-first-run",
    ],
  },
});

client.on("qr", (qr) => {
  const now = Date.now();
  if (now - lastQrAt < 3000) return;
  lastQrAt = now;
  lastQr = qr;
  ready = false;
  console.log("\n[WA] Scan this QR code with WhatsApp:");
  qrcodeTerminal.generate(qr, { small: true });
});

client.on("authenticated", () => {
  authenticated = true;
  lastQr = null;
  console.log("[WA] Authenticated.");
});

client.on("auth_failure", (msg) => {
  authenticated = false;
  ready = false;
  lastQr = null;
  console.error("[WA] Authentication failure:", msg);
});

client.on("code_received", (code) => {
  console.log("[WA] Pairing code received:", code);
});

client.on("ready", () => {
  ready = true;
  lastQr = null;
  console.log("[WA] Client is ready.");
});

client.on("disconnected", async (reason) => {
  ready = false;
  authenticated = false;
  lastDisconnect = { at: new Date().toISOString(), reason: String(reason ?? "") };
  console.error("[WA] Disconnected:", reason);
  console.log("[WA] Attempting to reconnect in 5s...");
  await sleep(5000);
  initializeWithRetry(1);
});

async function postWebhook(payload) {
  try {
    const res = await fetch(BACKEND_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[WEBHOOK] backend returned", res.status, text);
    }
  } catch (e) {
    console.error("[WEBHOOK] failed:", e?.message ?? e);
  }
}

client.on("message", async (message) => {
  // Only forward inbound user messages.
  if (!message || message.fromMe) return;

  // Basic payload: enough for the backend to decide what to do.
  const payload = {
    id: message.id?._serialized ?? null,
    from: message.from ?? null,
    to: message.to ?? null,
    body: message.body ?? "",
    timestamp: message.timestamp ?? null,
    type: message.type ?? null,
    isGroup: message.from?.endsWith("@g.us") ?? false,
  };

  // Simulate read receipts after a small random delay.
  try {
    const chat = await message.getChat();
    const delay = randInt(800, 3500);
    setTimeout(() => {
      chat.sendSeen().catch(() => {});
    }, delay);
  } catch {}

  await postWebhook(payload);
});

app.get("/status", (_req, res) => {
  const userInfo = ready && client.info
    ? { pushname: client.info.pushname ?? null, phone: client.info.wid?.user ?? null }
    : null;
  res.json({
    ok: true,
    ready,
    authenticated,
    hasQr: !!lastQr,
    lastDisconnect,
    userInfo,
  });
});

app.get("/qr", (_req, res) => {
  if (!lastQr) return res.status(404).json({ error: "no qr available" });
  res.json({ qr: lastQr });
});

app.post("/send", requireToken, async (req, res) => {
  const to = String(req.body?.to ?? "").trim();
  const text = String(req.body?.text ?? "").trim();
  const simulateTyping = req.body?.simulateTyping !== false;

  if (!to || !text) return res.status(400).json({ error: "`to` and `text` are required" });
  if (!ready) return res.status(503).json({ error: "whatsapp client not ready (scan QR?)" });

  try {
    // Enforce minimum spacing between messages to the same recipient.
    const last = lastSentAtByRecipient.get(to) ?? 0;
    const since = nowMs() - last;
    const extraWait = Math.max(0, MIN_DELAY_SAME_RECIPIENT_MS - since);
    if (extraWait > 0) await sleep(extraWait);

    // Apply "human-ish" delay before send (plus typing indicator).
    const randomDelay = randInt(RANDOM_SEND_DELAY_MIN_MS, RANDOM_SEND_DELAY_MAX_MS);
    const typeDelay = typingDurationMs(text);
    const waitMs = Math.max(randomDelay, typeDelay);

    const chat = await client.getChatById(to);
    if (simulateTyping) {
      await chat.sendStateTyping();
      await sleep(waitMs);
      await chat.clearState();
    } else {
      await sleep(randomDelay);
    }

    const sent = await client.sendMessage(to, text);
    lastSentAtByRecipient.set(to, nowMs());

    res.json({
      ok: true,
      messageId: sent?.id?._serialized ?? null,
      to,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/logout", requireToken, async (_req, res) => {
  try {
    await client.logout();
    ready = false;
    authenticated = false;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/pairing-code", requireToken, async (req, res) => {
  if (ready) return res.status(400).json({ error: "Already connected. No pairing needed." });
  const phoneNumber = String(req.body?.phoneNumber ?? "").trim();
  if (!phoneNumber) return res.status(400).json({ error: "`phoneNumber` is required (e.g. 9198xxxxxxx)" });
  try {
    const code = await client.requestPairingCode(phoneNumber);
    res.json({ ok: true, code });
  } catch (e) {
    const msg = String(e?.message ?? e);
    console.error("[WA] pairing-code error:", msg);
    if (msg.includes("already")) {
      res.status(400).json({ error: "Already pairing. Try scanning QR instead." });
    } else {
      res.status(500).json({ error: "Pairing failed. Make sure WhatsApp Web is loading (wait for QR), then try again." });
    }
  }
});

app.post("/cancel-pairing", requireToken, async (_req, res) => {
  try {
    await client.cancelPairingCode();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/chats", requireToken, async (_req, res) => {
  if (!ready) return res.status(503).json({ error: "whatsapp client not ready (scan QR?)" });
  try {
    const chats = await client.getChats();
    const items = [];
    for (const c of chats ?? []) {
      // Skip status/broadcast types and keep payload light.
      const id = c?.id?._serialized ?? c?.id ?? null;
      if (!id || typeof id !== "string") continue;
      if (id === "status@broadcast") continue;
      const name = c?.name ?? c?.formattedTitle ?? c?.pushname ?? id;
      const isGroup = id.endsWith("@g.us");
      const lastMessage = c?.lastMessage?.body ?? null;
      const lastMessageAt = c?.lastMessage?.timestamp ? new Date(c.lastMessage.timestamp * 1000).toISOString() : null;
      items.push({ id, name, isGroup, lastMessage, lastMessageAt });
    }
    res.json({ ok: true, chats: items });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

const MAX_INIT_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

function killStaleChrome() {
  try {
    execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: "ignore" });
  } catch {}
}

function removeLockFiles() {
  const sessionDir = path.join(AUTH_PATH, `session-${CLIENT_ID}`);
  if (!fs.existsSync(sessionDir)) return;
  const lockFiles = [
    "DevToolsActivePort",
    path.join("Default", "LOCK"),
    path.join("Default", "Service Worker", "Database", "LOCK"),
    path.join("Default", "Session Storage", "LOCK"),
    path.join("Default", "shared_proto_db", "LOCK"),
    path.join("Default", "shared_proto_db", "metadata", "LOCK"),
    path.join("Default", "Site Characteristics Database", "LOCK"),
    path.join("Default", "Sync Data", "LevelDB", "LOCK"),
    path.join("Default", "Segmentation Platform", "SignalStorageConfigDB", "LOCK"),
  ];
  for (const f of lockFiles) {
    const full = path.join(sessionDir, f);
    try { fs.unlinkSync(full); } catch {}
  }
}

async function initializeWithRetry(attempt = 1) {
  if (attempt === 1) {
    killStaleChrome();
    removeLockFiles();
    await sleep(1000);
  }
  try {
    await client.initialize();
  } catch (e) {
    const msg = String(e?.message ?? e);
    const retryable = msg.includes("Execution context was destroyed") ||
                      msg.includes("browser is already running") ||
                      msg.includes("Target closed");
    if (retryable && attempt < MAX_INIT_RETRIES) {
      console.error(`[WA] initialize failed (attempt ${attempt}/${MAX_INIT_RETRIES}): ${msg}`);
      console.log(`[WA] retrying in ${RETRY_DELAY_MS / 1000}s...`);
      killStaleChrome();
      removeLockFiles();
      await sleep(RETRY_DELAY_MS);
      return initializeWithRetry(attempt + 1);
    }
    console.error("[WA] initialize failed permanently:", msg);
    process.exit(1);
  }
}

app.listen(GATEWAY_PORT, () => {
  console.log(`[GATEWAY] listening on http://127.0.0.1:${GATEWAY_PORT}`);
  console.log(`[GATEWAY] webhook -> ${BACKEND_WEBHOOK_URL}`);
});

initializeWithRetry();
