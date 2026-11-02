// Garden: a second interface for the same shell (T-305 interface platform spike). Rooms are places in a night
// meadow, each grown as a plant from its room's id; new letters are fireflies around it; a letter you send flies
// there as a moth. It talks to the shell only through ../sdk/shell.ts.
import { NotGranted, shell, type Letter, type Room } from "../sdk/shell";
import "./garden.css";

const SVG = "http://www.w3.org/2000/svg";
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const BLOOMS = ["#e98bb4", "#8fb3f0", "#f2b850", "#cfdc8c", "#efe7fa", "#f49a7a"];
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Place = { room: Room; x: number; y: number; s: number; bloom: string; head: { x: number; y: number } };

const app = { rooms: [] as Room[], places: new Map<string, Place>(), open: null as string | null, letters: [] as Letter[], note: "" };

// --- small helpers ---------------------------------------------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
function svg(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function when(ts: number): string {
  const d = new Date(ts * 1000);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const clock = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return days < 1 ? clock : days < 7 ? `${d.toLocaleDateString(undefined, { weekday: "long" })}, ${clock}` : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- plants: five kinds, each drawn upward from (0, 0) -----------------------------------------------------------
function leaf(g: SVGElement, x: number, y: number, len: number, angle: number, fill: string) {
  g.append(svg("path", { d: `M0 0 Q ${len * 0.5} ${-len * 0.32} ${len} 0 Q ${len * 0.5} ${len * 0.32} 0 0Z`, fill, transform: `translate(${x} ${y}) rotate(${angle})` }));
}
function plant(kind: number, r: () => number, h: number, bloom: string): { g: SVGElement; head: { x: number; y: number } } {
  const g = svg("g", { class: "plant" });
  const lean = (r() - 0.5) * h * 0.35;
  const stem = (top: { x: number; y: number }) =>
    g.append(svg("path", { d: `M0 0 Q ${lean * 0.2} ${-h * 0.5} ${top.x} ${top.y}`, class: "stem" }));
  if (kind === 0) {
    // a meadow flower: petals around a seed eye
    const head = { x: lean, y: -h };
    stem(head);
    leaf(g, lean * 0.08, -h * 0.28, h * 0.32, -30 - r() * 20, "#4f8a5b");
    leaf(g, lean * 0.14, -h * 0.46, h * 0.28, 200 + r() * 20, "#3f7550");
    const n = 6 + Math.floor(r() * 5), pr = h * 0.15;
    const flower = svg("g", { transform: `translate(${head.x} ${head.y})`, class: "bloom" });
    for (let i = 0; i < n; i++) flower.append(svg("ellipse", { cx: pr * 0.62, cy: 0, rx: pr * 0.62, ry: pr * 0.24, fill: bloom, transform: `rotate(${(360 / n) * i})` }));
    flower.append(svg("circle", { r: pr * 0.3, fill: "#f6d77a" }));
    g.append(flower);
    return { g, head };
  }
  if (kind === 1) {
    // a foxglove spire of bells
    const head = { x: lean, y: -h };
    stem(head);
    leaf(g, 0, -h * 0.1, h * 0.36, -12, "#4f8a5b");
    leaf(g, 0, -h * 0.12, h * 0.33, 192, "#3f7550");
    const bells = 5 + Math.floor(r() * 4);
    for (let i = 0; i < bells; i++) {
      const t = 0.42 + (i / bells) * 0.55, side = i % 2 ? 1 : -1, size = h * (0.12 - i * 0.008);
      const bx = lean * t * t + side * size * 0.45, by = -h * t;
      g.append(svg("path", { d: `M0 0 C ${size * 0.5} 0 ${size * 0.6} ${size * 0.8} ${size * 0.35} ${size} L ${-size * 0.35} ${size} C ${-size * 0.6} ${size * 0.8} ${-size * 0.5} 0 0 0Z`, fill: bloom, transform: `translate(${bx} ${by}) rotate(${side * 18})`, class: "bell" }));
    }
    return { g, head };
  }
  if (kind === 2) {
    // a cluster of glowing mushrooms
    const caps = 2 + Math.floor(r() * 3);
    let head = { x: 0, y: -h * 0.6 };
    for (let i = 0; i < caps; i++) {
      const ch = h * (0.6 - i * 0.13) * (0.85 + r() * 0.2), cw = h * (0.34 - i * 0.06), cx = (i % 2 ? 1 : -1) * i * h * 0.13;
      g.append(svg("path", { d: `M${cx - cw * 0.08} 0 Q ${cx - cw * 0.1} ${-ch * 0.6} ${cx - cw * 0.05} ${-ch} L ${cx + cw * 0.05} ${-ch} Q ${cx + cw * 0.1} ${-ch * 0.6} ${cx + cw * 0.08} 0Z`, fill: "#e8e1cf" }));
      g.append(svg("path", { d: `M${cx - cw / 2} ${-ch} Q ${cx} ${-ch - cw * 0.75} ${cx + cw / 2} ${-ch}Z`, fill: bloom, class: "cap" }));
      for (let d = 0; d < 3; d++) g.append(svg("circle", { cx: cx + (d - 1) * cw * 0.2, cy: -ch - cw * (0.12 + (d % 2) * 0.14), r: cw * 0.045, fill: "#fff6d8", opacity: 0.85 }));
      if (i === 0) head = { x: cx, y: -ch - cw * 0.3 };
    }
    return { g, head };
  }
  if (kind === 3) {
    // a fern frond with its tip still curled
    const head = { x: lean * 0.9, y: -h * 0.95 };
    g.append(svg("path", { d: `M0 0 Q ${lean * 0.3} ${-h * 0.55} ${head.x} ${head.y} q ${h * 0.05} ${-h * 0.06} ${h * 0.09} ${-h * 0.01} q ${h * 0.02} ${h * 0.05} ${-h * 0.04} ${h * 0.05}`, class: "stem fern" }));
    const n = 9;
    for (let i = 1; i < n; i++) {
      const t = i / n, x = lean * 0.3 * 2 * t * (1 - t) + head.x * t * t, y = -h * 0.55 * 2 * t * (1 - t) + head.y * t * t, len = h * 0.24 * (1 - t * 0.65);
      leaf(g, x, y, len, -20 - t * 20, i % 2 ? "#5d9a62" : "#4f8a5b");
      leaf(g, x, y, len, 200 + t * 20, i % 2 ? "#4f8a5b" : "#3f7550");
    }
    g.append(svg("circle", { cx: head.x, cy: head.y - h * 0.04, r: h * 0.035, fill: bloom, class: "spore" }));
    return { g, head };
  }
  // a seed clock: a dandelion gone to seed
  const head = { x: lean, y: -h };
  stem(head);
  leaf(g, 0, -h * 0.05, h * 0.3, -8, "#4f8a5b");
  leaf(g, 0, -h * 0.06, h * 0.26, 186, "#3f7550");
  const clock = svg("g", { transform: `translate(${head.x} ${head.y})`, class: "bloom" });
  const rays = 18, rr = h * 0.16;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    clock.append(svg("line", { x1: 0, y1: 0, x2: Math.cos(a) * rr, y2: Math.sin(a) * rr, class: "ray" }));
    clock.append(svg("circle", { cx: Math.cos(a) * rr, cy: Math.sin(a) * rr, r: h * 0.012, fill: bloom }));
  }
  clock.append(svg("circle", { r: h * 0.03, fill: "#c9b98a" }));
  g.append(clock);
  return { g, head };
}

// --- the meadow ----------------------------------------------------------------------------------------------
const root = document.getElementById("garden") as HTMLElement;
const meadow = svg("svg", { class: "meadow", role: "group", "aria-label": "Places" }) as SVGSVGElement;
const header = el("header", { class: "top" });
const sheet = el("section", { class: "sheet", hidden: "" });
const status = el("p", { class: "status", role: "status", "aria-live": "polite" });
root.append(meadow, header, sheet, status);

function say(text: string) {
  status.textContent = text;
}

function drawHeader() {
  header.replaceChildren();
  const title = el("div", { class: "title" });
  title.append(el("h1", {}, "Garden"));
  const fresh = app.rooms.filter((r) => r.unread > 0).length;
  title.append(el("p", { class: "summary" }, app.rooms.length ? `${plural(app.rooms.length, "place", "places")}, ${fresh ? `${fresh} with new letters` : "all quiet"}` : ""));
  const back = el("button", { class: "door", type: "button" }, "Back to Uni");
  back.addEventListener("click", () => void shell.interfaces.use("uni").catch((e) => say(`Uni didn't open: ${String(e?.message ?? e)}`)));
  header.append(title, back);
}

function layout(): Place[] {
  const w = meadow.clientWidth || window.innerWidth, h = meadow.clientHeight || window.innerHeight;
  const horizon = h * 0.3, cx = w / 2, cy = horizon + (h - horizon) * 0.56;
  const rx = w * 0.37, ry = (h - horizon) * 0.36;
  const sorted = [...app.rooms].sort((a, b) => (b.last_ts ?? 0) - (a.last_ts ?? 0));
  const n = Math.max(sorted.length, 1);
  // Bold while there are few places; smaller as the meadow fills, and smaller again if they can't all stand apart.
  let base = Math.min(1.5, Math.max(1, Math.min(w, h) / 520)) * Math.min(1, Math.max(0.5, Math.sqrt(8 / n)));
  let places: Place[] = [];
  for (let attempt = 0; attempt < 8; attempt++, base *= 0.88) {
    places = sorted.map((room, i) => {
      const rad = Math.sqrt((i + 0.6) / n), a = i * GOLDEN + 0.6;
      const x = cx + Math.cos(a) * rad * rx, y = cy + Math.sin(a) * rad * ry;
      const depth = (y - horizon) / (h - horizon);
      const s = base * (0.72 + depth * 0.5) * (1.25 - (i / n) * 0.5);
      return { room, x, y, s, bloom: BLOOMS[seedOf(room.id) % BLOOMS.length], head: { x, y } };
    });
    if (relax(places, w, h)) break;
  }
  return places.sort((a, b) => a.y - b.y);
}

/** Pushes places apart until no two plants' footprints overlap; false if they still do. */
function relax(places: Place[], w: number, h: number): boolean {
  const box = (p: Place) => ({ hw: 58 * p.s, top: 150 * p.s, foot: 34 });
  for (let iter = 0; iter < 120; iter++) {
    let moved = false;
    for (let i = 0; i < places.length; i++) for (let j = i + 1; j < places.length; j++) {
      const a = places[i], b = places[j], ba = box(a), bb = box(b);
      const ox = ba.hw + bb.hw - Math.abs(a.x - b.x);
      const oy = Math.min(a.y + ba.foot, b.y + bb.foot) - Math.max(a.y - ba.top, b.y - bb.top);
      if (ox <= 0 || oy <= 0) continue;
      moved = true;
      if (ox < oy) { const d = (ox / 2 + 1) * Math.sign(a.x - b.x || 1); a.x += d; b.x -= d; }
      else { const d = (oy / 2 + 1) * Math.sign(a.y - b.y || 1); a.y += d; b.y -= d; }
    }
    for (const p of places) {
      const b = box(p);
      p.x = Math.min(w - b.hw - 6, Math.max(b.hw + 6, p.x));
      p.y = Math.min(h - b.foot - 6, Math.max(b.top + 120, p.y));
    }
    if (!moved) return true;
  }
  return false;
}

function drawMeadow() {
  const w = meadow.clientWidth || window.innerWidth, h = meadow.clientHeight || window.innerHeight;
  meadow.setAttribute("viewBox", `0 0 ${w} ${h}`);
  meadow.replaceChildren();
  const defs = svg("defs");
  defs.innerHTML = `
    <radialGradient id="moonglow"><stop offset="0" stop-color="#f7f1d6" stop-opacity=".9"/><stop offset=".18" stop-color="#f7f1d6" stop-opacity=".35"/><stop offset="1" stop-color="#f7f1d6" stop-opacity="0"/></radialGradient>
    <radialGradient id="firefly"><stop offset="0" stop-color="#fffbd0"/><stop offset=".35" stop-color="#f4f08a" stop-opacity=".8"/><stop offset="1" stop-color="#f4f08a" stop-opacity="0"/></radialGradient>
    <linearGradient id="hill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#25493f"/><stop offset="1" stop-color="#13271f"/></linearGradient>`;
  meadow.append(defs);
  const r = rng(7);
  for (let i = 0; i < 46; i++) meadow.append(svg("circle", { cx: r() * w, cy: r() * h * 0.3, r: r() * 1.3 + 0.3, class: "star", style: `--tw:${2 + r() * 5}s` }));
  meadow.append(svg("circle", { cx: w * 0.82, cy: h * 0.12, r: Math.min(w, h) * 0.32, fill: "url(#moonglow)" }));
  meadow.append(svg("circle", { cx: w * 0.82, cy: h * 0.12, r: Math.min(w, h) * 0.045, fill: "#f7f1d6" }));
  const horizon = h * 0.3;
  meadow.append(svg("path", { d: `M0 ${horizon + 30} C ${w * 0.25} ${horizon - 22} ${w * 0.55} ${horizon + 38} ${w} ${horizon - 6} L ${w} ${h} L 0 ${h}Z`, fill: "url(#hill)" }));
  for (let i = 0; i < 140; i++) {
    const gx = r() * w, gy = horizon + 20 + r() * (h - horizon), gh = 6 + r() * 12 * (gy / h);
    meadow.append(svg("path", { d: `M${gx} ${gy} q ${(r() - 0.5) * 6} ${-gh * 0.6} ${(r() - 0.5) * 8} ${-gh}`, class: "blade" }));
  }
  app.places.clear();
  const placed = layout();
  // A footpath between the places, from the newest to the quietest.
  const walk = [...placed].sort((a, b) => (b.room.last_ts ?? 0) - (a.room.last_ts ?? 0));
  if (walk.length > 1) {
    let d = `M${walk[0].x} ${walk[0].y + 14}`;
    for (let i = 1; i < walk.length; i++) {
      const a = walk[i - 1], b = walk[i];
      d += ` C ${a.x + (b.x - a.x) * 0.5} ${a.y + 40} ${b.x - (b.x - a.x) * 0.3} ${b.y + 40} ${b.x} ${b.y + 14}`;
    }
    meadow.append(svg("path", { d, class: "path" }));
  }
  const used = new Set<number>();
  for (const p of placed) {
    const rr = rng(seedOf(p.room.id));
    // Each place's plant comes from its room's id; no kind repeats until all five have grown.
    let kind = Math.floor(rr() * 5);
    while (used.has(kind) && used.size < 5) kind = (kind + 1) % 5;
    used.add(kind);
    if (used.size === 5) used.clear();
    const height = 110 * (0.8 + rr() * 0.4);
    const g = svg("g", { class: "place", transform: `translate(${p.x} ${p.y}) scale(${p.s})`, tabindex: 0, role: "button", "data-room": p.room.id,
      "aria-label": `${p.room.name}${p.room.unread ? `, ${plural(p.room.unread, "new letter", "new letters")}` : ""}` });
    g.append(svg("ellipse", { cx: 0, cy: 2, rx: 46, ry: 9, class: "shade" }));
    const { g: pl, head } = plant(kind, rr, height, p.bloom);
    // The whole plant and its name take a tap, not only its painted strokes.
    g.append(svg("rect", { x: Math.min(0, head.x) - 50, y: head.y - 50, width: Math.abs(head.x) + 100, height: 90 - head.y, class: "hit" }));
    g.append(pl);
    g.append(svg("ellipse", { cx: head.x, cy: head.y, rx: 52, ry: 52, class: "halo" }));
    if (p.room.mentions) g.append(svg("circle", { cx: head.x, cy: head.y, r: 30, class: "called", stroke: p.bloom }));
    const flies = Math.min(p.room.unread, 9);
    for (let i = 0; i < flies; i++) {
      const orbit = svg("g", { transform: `translate(${head.x} ${head.y})` });
      const spin = svg("g", { class: "orbit", style: `--d:${5 + rr() * 6}s;--o:${-rr() * 10}s;--dir:${i % 2 ? "reverse" : "normal"}` });
      const fx = 24 + rr() * 18, fy = (rr() - 0.5) * 20;
      const fly = svg("g", { class: "fly", style: `--tw:${1.4 + rr() * 2}s` });
      fly.append(svg("circle", { cx: fx, cy: fy, r: 13, fill: "url(#firefly)" }), svg("circle", { cx: fx, cy: fy, r: 2.6, fill: "#fffbe0" }));
      spin.append(fly);
      orbit.append(spin);
      g.append(orbit);
    }
    const open = () => void openPlace(p.room.id);
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => { const k = (e as KeyboardEvent).key; if (k === "Enter" || k === " ") { e.preventDefault(); open(); } });
    meadow.append(g);
    // Names stay a readable size whatever the plant's scale.
    const label = svg("text", { x: p.x, y: p.y + 26, class: "name", "aria-hidden": "true" });
    label.textContent = p.room.name;
    label.addEventListener("click", open);
    meadow.append(label);
    app.places.set(p.room.id, { ...p, head: { x: p.x + head.x * p.s, y: p.y + head.y * p.s } });
  }
  if (!app.rooms.length) {
    const t = svg("text", { x: w / 2, y: h * 0.62, class: "empty" });
    t.textContent = app.note || "No places yet. Rooms you join grow here.";
    meadow.append(t);
  }
}

// --- letters ---------------------------------------------------------------------------------------------------
async function openPlace(id: string) {
  app.open = id;
  const room = app.rooms.find((r) => r.id === id);
  if (!room) return;
  sheet.hidden = false;
  sheet.style.setProperty("--bloom", app.places.get(id)?.bloom ?? BLOOMS[0]);
  sheet.setAttribute("aria-label", `Letters in ${room.name}`);
  drawSheet(room, true);
  try {
    app.letters = await shell.rooms.letters(id);
    if (app.open !== id) return;
    drawSheet(room, false);
    if (room.unread) void shell.rooms.markRead(id).then(refreshRooms).catch(() => {});
  } catch (e) {
    say(e instanceof NotGranted ? "This garden may not read letters. Allow it in Uni's settings." : `The letters didn't load: ${(e as Error).message}`);
  }
}

function drawSheet(room: Room, loading: boolean) {
  sheet.replaceChildren();
  const head = el("div", { class: "sheet-head" });
  head.append(el("h2", {}, room.name));
  const close = el("button", { class: "close", type: "button", "aria-label": "Close letters" }, "Close");
  close.addEventListener("click", closePlace);
  head.append(close);
  const list = el("ol", { class: "letters" });
  const shown = loading ? [] : app.letters.filter((l) => !l.root).slice(-12);
  if (!loading && !shown.length) list.append(el("li", { class: "none" }, "No letters here yet. Yours can be the first."));
  shown.forEach((l, i) => {
    const li = el("li", { class: "letter", style: `--tilt:${((seedOf(l.ref) % 9) - 4) * 0.12}deg` });
    li.append(el("p", { class: "body" }, l.body));
    const sig = el("p", { class: "sig" });
    sig.append(el("span", { class: "who" }, l.author_name || "Someone"), el("span", { class: "when" }, when(l.ts)));
    li.append(sig);
    li.dataset.i = String(i);
    list.append(li);
  });
  const form = el("form", { class: "compose" });
  const box = el("textarea", { rows: "2", name: "letter", "aria-label": `Write a letter to ${room.name}`, placeholder: `Write to ${room.name}` });
  const send = el("button", { type: "submit", class: "send" }, "Send letter");
  form.append(box, send);
  form.addEventListener("submit", (e) => { e.preventDefault(); void sendLetter(room, box, send); });
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
  sheet.append(head, list, form);
  list.scrollTop = list.scrollHeight;
}

function closePlace() {
  app.open = null;
  sheet.hidden = true;
  (meadow.querySelector(`[data-room="${CSS.escape(app.rooms[0]?.id ?? "")}"]`) as SVGGElement | null)?.focus();
}

async function sendLetter(room: Room, box: HTMLTextAreaElement, button: HTMLButtonElement) {
  const body = box.value.trim();
  if (!body) return;
  button.disabled = true;
  try {
    const sent = await shell.rooms.send(room.id, body);
    box.value = "";
    app.letters = [...app.letters.filter((l) => l.ref !== sent.ref), sent];
    const from = button.getBoundingClientRect();
    drawSheet(room, false);
    say(`Sent to ${room.name}.`);
    fly({ x: from.left + from.width / 2, y: from.top }, room.id, "out");
  } catch (e) {
    say(e instanceof NotGranted ? "This garden may not send letters. Allow it in Uni's settings." : `The letter didn't go: ${(e as Error).message}. It's still in the box.`);
  } finally {
    button.disabled = false;
  }
}

/** A paper moth flies between a point on screen and a place's flower: out for a letter you sent, in for a new one. */
function fly(from: { x: number; y: number }, id: string, way: "out" | "in") {
  const place = app.places.get(id);
  if (!place || reduced()) return;
  const box = meadow.getBoundingClientRect(), vb = meadow.viewBox.baseVal;
  const k = vb.width ? box.width / vb.width : 1;
  const to = { x: box.left + place.head.x * k, y: box.top + place.head.y * k };
  const [a, b] = way === "out" ? [from, to] : [to, from].reverse() as [typeof from, typeof from];
  const moth = el("div", { class: `moth ${way}`, "aria-hidden": "true" });
  moth.innerHTML = `<svg viewBox="-20 -14 40 28"><path class="wing" d="M0 0 C -6 -14 -20 -12 -16 -2 C -14 4 -6 4 0 0Z"/><path class="wing r" d="M0 0 C 6 -14 20 -12 16 -2 C 14 4 6 4 0 0Z"/><path class="wing low" d="M0 1 C -5 8 -12 10 -10 4Z"/><path class="wing low r" d="M0 1 C 5 8 12 10 10 4Z"/><ellipse rx="1.6" ry="6" cy="1" fill="#3b3a2c"/></svg>`;
  document.body.append(moth);
  const lift = Math.max(120, Math.abs(a.x - b.x) * 0.4);
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, u = 1 - t;
    const x = u * u * a.x + 2 * u * t * ((a.x + b.x) / 2 + (way === "out" ? -80 : 80)) + t * t * b.x;
    const y = u * u * a.y + 2 * u * t * (Math.min(a.y, b.y) - lift) + t * t * b.y + Math.sin(t * Math.PI * 6) * 6;
    frames.push({ transform: `translate(${x}px, ${y}px) rotate(${Math.sin(t * Math.PI * 4) * 14}deg) scale(${way === "out" ? 1 - t * 0.45 : 0.55 + t * 0.45})`, opacity: t > 0.92 ? (1 - t) * 12 : 1 });
  }
  moth.animate(frames, { duration: 1700, easing: "cubic-bezier(.3,.1,.3,1)" }).finished.then(() => moth.remove(), () => moth.remove());
}

// --- data ------------------------------------------------------------------------------------------------------
async function refreshRooms() {
  app.rooms = await shell.rooms.list();
  drawHeader();
  drawMeadow();
}

async function start() {
  if (!(await shell.handshake().catch(() => true))) return;
  drawHeader();
  try {
    await refreshRooms();
    shell.ready();
    say("");
  } catch (e) {
    app.note = e instanceof NotGranted ? "This garden may not see your rooms. Allow it in Uni's settings." : "The rooms didn't load.";
    drawMeadow();
    shell.ready();
  }
  // The device's copy first, then whatever the relay has that's newer.
  void shell.rooms.sync().then(refreshRooms).catch(() => {});
  await shell.rooms.watch(async (p) => {
    if (p.kind !== "message" && p.kind !== "rooms") return;
    const before = new Map(app.rooms.map((r) => [r.id, r.unread]));
    await refreshRooms().catch(() => {});
    if (p.kind === "message" && p.channel) {
      const room = app.rooms.find((r) => r.id === p.channel);
      if (room && room.unread > (before.get(room.id) ?? 0)) fly({ x: window.innerWidth + 30, y: window.innerHeight * 0.2 }, room.id, "in");
      if (app.open === p.channel && room) {
        app.letters = await shell.rooms.letters(room.id).catch(() => app.letters);
        drawSheet(room, false);
      }
    }
  }).catch(() => {});
  let resize = 0;
  window.addEventListener("resize", () => { window.clearTimeout(resize); resize = window.setTimeout(drawMeadow, 120); });
}

void start();
