import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8000";
  const tunnelMode =
    mode === "tunnel" || env.QBR_TUNNEL === "1" || process.env.QBR_TUNNEL === "1";

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      // Cloudflare quick tunnel (*.trycloudflare.com) and LAN hostnames
      allowedHosts: true,
      // HTTPS tunnel exposes only :443 — HMR must use wss on 443, not :5173
      hmr: tunnelMode
        ? {
            protocol: "wss",
            clientPort: 443
          }
        : undefined,
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
          timeout: 120000
        },
        "/health": {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false
        }
      }
    }
  };
});
