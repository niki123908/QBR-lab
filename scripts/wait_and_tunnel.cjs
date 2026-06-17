/**
 * Start Cloudflare quick tunnel to Vite (5173).
 * --nowait  skip waiting for dev server (use when `npm run dev` is already up)
 */
const { Tunnel } = require("cloudflared");

const port = Number(process.env.QBR_DEV_PORT || 5173);
const host = process.env.QBR_DEV_HOST || "127.0.0.1";
const target = `http://${host}:${port}`;
const timeoutMs = Number(process.env.QBR_TUNNEL_WAIT_MS || 120000);
const skipWait = process.argv.includes("--nowait");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevServer() {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(target, { method: "GET" });
      if (response.ok || response.status === 404) return;
    } catch {
      // not ready yet
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for dev server at ${target}. Start it with: npm run dev`);
}

function printShareLink(url) {
  console.log("");
  console.log("============================================================");
  console.log("  CHIA SE LINK NAY CHO NGUOI KHAC:");
  console.log(`  ${url}`);
  console.log("============================================================");
  console.log("");
}

async function verifyTunnelApi(url) {
  const healthUrl = `${url.replace(/\/$/, "")}/health`;
  const apiUrl = `${url.replace(/\/$/, "")}/api/presets`;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const health = await fetch(healthUrl);
      const presets = await fetch(apiUrl);
      if (health.ok && presets.ok) {
        console.log("[tunnel] Kiem tra API qua tunnel: OK (/health, /api/presets)");
        return true;
      }
      console.log(
        `[tunnel] Kiem tra API lan ${attempt}: health=${health.status} presets=${presets.status}`
      );
    } catch (err) {
      console.log(`[tunnel] Kiem tra API lan ${attempt}: ${err.message || err}`);
    }
    await sleep(1500);
  }
  console.warn("[tunnel] CANH BAO: API qua tunnel chua phan hoi. Thu F5 hoac doi 10s roi mo lai link.");
  return false;
}

async function main() {
  if (!skipWait) {
    console.log(`[tunnel] Dang cho ${target} ...`);
    await waitForDevServer();
  } else {
    console.log(`[tunnel] Ket noi toi ${target} (khong cho dev server).`);
  }

  console.log("[tunnel] Dang tao Cloudflare tunnel...");
  const tunnel = Tunnel.quick(target);

  tunnel.once("url", async (url) => {
    printShareLink(url);
    await verifyTunnelApi(url);
  });
  tunnel.on("connected", () => console.log("[tunnel] Da ket noi Cloudflare. Link o tren."));
  tunnel.on("error", (err) => console.error("[tunnel] Loi:", err.message || err));
  tunnel.on("exit", (code) => process.exit(code ?? 0));

  const stop = () => {
    try {
      tunnel.stop();
    } catch {
      process.exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("[tunnel]", err.message || err);
  process.exit(1);
});
