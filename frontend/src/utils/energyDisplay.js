import { createContext } from "react";
export const EnergyDisplayContext = createContext({});
export function rateFraction(rate, defaults) {
  if (rate == null || !Number.isFinite(Number(rate)) || !defaults) return null;
  const min = Number(defaults.harvest_min), max = Number(defaults.harvest_max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return max === min ? 1 : Math.max(0, Math.min(1, (Number(rate) - min) / (max - min)));
}
// Interpolate in RGB; user-selected endpoints remain exact.
export function rateColor(low, high, fraction) {
  const channel = (color, i) => parseInt(color.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map(i => Math.round(channel(low, i) * (1 - fraction) + channel(high, i) * fraction).toString(16).padStart(2, "0")).join("");
}
