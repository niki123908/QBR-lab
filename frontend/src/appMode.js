const modeParameter = new URLSearchParams(window.location.search).get("mode");
export const IS_ENERGY_MODE = modeParameter === "energy";

// Reload on mode changes so pending requests and component caches cannot cross workspaces.
export function toggleAppMode() {
  const url = new URL(window.location.href);
  if (IS_ENERGY_MODE) url.searchParams.delete("mode");
  else url.searchParams.set("mode", "energy");
  window.location.assign(url.href);
}

export const modeStorage = {
  getItem(key) { return localStorage.getItem(IS_ENERGY_MODE ? `energy.${key}` : key); },
  setItem(key, value) { localStorage.setItem(IS_ENERGY_MODE ? `energy.${key}` : key, value); },
  removeItem(key) { localStorage.removeItem(IS_ENERGY_MODE ? `energy.${key}` : key); }
};

document.documentElement.dataset.mode = IS_ENERGY_MODE ? "energy" : "broadcast";
