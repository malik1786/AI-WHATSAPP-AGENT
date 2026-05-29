import { spawn } from "node:child_process";
import net from "node:net";

function getPort() {
  const raw = process.env.GATEWAY_PORT ?? "3001";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 3001;
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      try {
        socket.destroy();
      } catch {}
      resolve(ok);
    };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function main() {
  const port = getPort();
  const already = await isListening(port);
  if (already) {
    console.log(`[GW] already listening on http://127.0.0.1:${port} (skipping start)`);
    process.exit(0);
  }

  const child = spawn("npm", ["run", "start"], {
    cwd: new URL("../gateway/", import.meta.url),
    stdio: "inherit",
    shell: true,
    env: process.env,
  });

  child.on("exit", (code) => process.exit(code ?? 1));
}

main().catch((e) => {
  console.error("[GW] failed to start:", e?.message ?? e);
  process.exit(1);
});

