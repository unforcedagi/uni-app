// T-335 glow-up: the living accent follows the time of day. The root's `data-tide` is dawn (5-9), day (9-17), dusk (17-21) or night;
// glow.css gives each its hue (clay, moss, indigo; night is the dark palette's lamp). Checked every ten minutes, written only on a change.
export type Tide = "dawn" | "day" | "dusk" | "night";

export const tideAt = (hour: number): Tide => (hour < 5 ? "night" : hour < 9 ? "dawn" : hour < 17 ? "day" : hour < 21 ? "dusk" : "night");

let started = false;
export function startTide() {
  if (typeof document === "undefined") return;
  const set = () => { const t = tideAt(new Date().getHours()); if (document.documentElement.dataset.tide !== t) document.documentElement.dataset.tide = t; };
  set();
  if (started) return;
  started = true;
  setInterval(set, 10 * 60_000);
}
