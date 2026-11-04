/** Same-origin `/api` in dev (Vite proxy) — works with Cloudflare tunnel on one port. */
import { IS_ENERGY_MODE } from "./appMode.js";
const base = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");
export const API_BASE = IS_ENERGY_MODE ? `${base}/energy` : base;
