// What a round is judging. A card can say many things at once (a font and its words, a picture and its colour), so every
// round names the one thing asked about, a pair varies only that, and a reaction records it: what's learned from a pick
// is only what the pick was about. A screen with no colour (a greyscale tablet) changes what can be asked: colour turns
// into light and dark, and nothing seen there teaches colour.
import type { Ask, Card, DealOptions, Dimension, GameId } from "./types.ts";

// ---------- which features are about what ----------
const COLOUR = new Set(["warm", "cool", "earthy", "earthy-natural", "vivid", "vivid-saturated", "muted", "pastel", "neon", "monochrome"].map((w) => `visual:${w}`));
/** an importer's own slug can name a colour too ("visual:burnt-orange") */
const COLOUR_WORD = /(^|-)(colou?rs?|colou?red|colou?rful|hues?|tints?|tinted|tones|saturated|warm|cool|earth|earthy|sepia|amber|gold|golden|rust|red|orange|yellow|green|blue|teal|purple|violet|pink|magenta|turquoise)(-|$)/;
const VALUE = new Set(["dark", "light-paper", "paper", "high-contrast", "low-contrast"].map((w) => `visual:${w}`));
const TYPE = new Set(["serif", "book-serif", "serif-display", "clean-grotesk", "sans", "oversized-type", "small-quiet-type", "characterful-type", "mono-technical", "hand-lettered", "type-as-image"].map((w) => `visual:${w}`));

export function isColourFeature(f: string): boolean {
  return COLOUR.has(f) || (f.startsWith("visual:") && COLOUR_WORD.test(f.slice(7)));
}

/** Does this feature belong to what was being judged? */
function about(f: string, d: Dimension): boolean {
  switch (d) {
    case "type": return TYPE.has(f);
    case "words": case "voice": return f.startsWith("words:");
    case "colour": return isColourFeature(f) || VALUE.has(f);
    case "image": case "layout": case "design": return f.startsWith("visual:");
    case "motion": return f.startsWith("motion:");
    case "sound": return f.startsWith("sound:");
    case "systems": return f.startsWith("systems:");
    default: return true; // value is derived from the palette; clip and claim are about the whole thing
  }
}

// ---------- light and dark, from a palette ----------
function lumaOf(hex: string): number | null {
  // #rgb, #rgba, #rrggbb or #rrggbbaa; alpha plays no part
  const m = /^#(?:([0-9a-f]{6})(?:[0-9a-f]{2})?|([0-9a-f]{3})[0-9a-f]?)$/i.exec(hex);
  if (!m) return null;
  const h = m[1] ?? [...m[2]].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function tones(palette: readonly string[]): { mean: number; range: number } | null {
  const ls = palette.map(lumaOf).filter((l): l is number => l !== null);
  if (!ls.length) return null;
  return { mean: ls.reduce((a, b) => a + b, 0) / ls.length, range: Math.max(...ls) - Math.min(...ls) };
}

/** What a palette says with its colour taken away. The same answer for a palette and for its greys. */
export function valueFeatures(palette: readonly string[]): string[] {
  const t = tones(palette);
  if (!t) return [];
  const out: string[] = [];
  if (t.range >= 0.6) out.push("visual:high-contrast");
  else if (t.range <= 0.35) out.push("visual:low-contrast");
  if (t.mean <= 0.35) out.push("visual:dark");
  else if (t.mean >= 0.65) out.push("visual:light-paper");
  return out;
}

export function greyOf(hex: string): string {
  const l = lumaOf(hex);
  if (l === null) return hex;
  const v = Math.round(l * 255).toString(16).padStart(2, "0");
  return `#${v}${v}${v}`;
}

// ---------- a card's dimension, and the words for it ----------
export function dimensionOf(card: Card, opts: DealOptions = {}): Dimension {
  switch (card.kind) {
    case "type": return "type";
    case "sentence": return "words";
    case "palette": return opts.grey ? "value" : "colour";
    case "image": return "image";
    case "layout": return "layout";
    case "sound": return "sound";
    case "clip": return "clip";
    case "motion": return "motion";
    case "voice": return "voice";
    case "question": return "systems";
    case "artifact": {
      const t = card.artifact?.template;
      return t === "copy" ? "words" : t === "motion" ? "motion" : t === "layout" ? "layout" : "design";
    }
  }
}

const PAIR: Partial<Record<Dimension, { prompt: string; detail: string; grey?: string }>> = {
  type: { prompt: "Which type feels more like you?", detail: "Same words on both. Only the lettering changes." },
  words: { prompt: "Which wording feels more like you?", detail: "Same lettering on both. Only the words change." },
  colour: { prompt: "Which colours feel more like you?", detail: "Same little landscape on both. Only the colours change." },
  value: { prompt: "Which light and dark feels more like you?", detail: "Same little landscape, in greys. Only the tones change." },
  image: { prompt: "Which picture pulls you more?", detail: "The whole picture, not its name.", grey: "Shape, light and texture. Colour isn't part of this one." },
  layout: { prompt: "Which page design feels more like you?", detail: "How the page looks, not what it says.", grey: "How the page is laid out, not what it says. Colour isn't part of this one." },
  motion: { prompt: "Which movement feels more like you?", detail: "The same shape on both. Only the way it moves changes." },
  sound: { prompt: "Which sound feels more like you?", detail: "Play them both. Only the sound counts." },
  clip: { prompt: "Which clip pulls you more?", detail: "Picture, movement and sound together.", grey: "Movement, shape and sound together. Colour isn't part of this one." },
};

const GALLERY: Partial<Record<Dimension, { prompt: string; detail: string; grey?: string }>> = {
  image: { prompt: "Does this picture pull you?", detail: "Pin it if it does. The picture, not its name.", grey: "Pin it if it does. Shape, light and texture; colour isn't part of this one." },
  layout: { prompt: "Does this page design pull you?", detail: "Pin it if it does. How it looks, not what it says.", grey: "Pin it if it does. How it's laid out; colour isn't part of this one." },
  clip: { prompt: "Does this clip pull you?", detail: "Pin it if it does. Picture, movement and sound together.", grey: "Pin it if it does. Movement, shape and sound; colour isn't part of this one." },
  sound: { prompt: "Does this sound pull you?", detail: "Pin it if it does. Only the sound counts." },
};

const FIX: Partial<Record<Dimension, { prompt: string; detail: string; grey?: string }>> = {
  design: { prompt: "Does the look feel right?", detail: "Slide it until it does. The words stay the same: judge the colour, shape and spacing.", grey: "Slide it until it does. The words stay the same: judge the contrast, shape and spacing." },
  words: { prompt: "Do these words sound right?", detail: "Slide until they do. The lettering stays the same: only the wording changes." },
  motion: { prompt: "Does the movement feel right?", detail: "Slide it until it does. Only the way it moves changes." },
  layout: { prompt: "Does the page design feel right?", detail: "Slide it until it does. The words stay the same: judge the layout and lettering." },
};

export function askFor(game: Exclude<GameId, "garden">, dimension: Dimension, opts: DealOptions = {}): Ask {
  if (game === "who-said-it") return { dimension, prompt: "Who wrote these words?", detail: "Judge the voice. Every line is set the same way." };
  if (game === "ripple") return { dimension, prompt: "How should this work?", detail: "No right answer. It's your system, in your words." };
  const table = game === "this-or-that" ? PAIR : game === "gallery" ? GALLERY : FIX;
  const t = table[dimension] ?? PAIR[dimension];
  return t ? { dimension, prompt: t.prompt, detail: (opts.grey && t.grey) || t.detail } : { dimension, prompt: "Does this feel right?", detail: "Go with your first feeling." };
}

// ---------- what counts, and what can be dealt ----------
/** The features a reaction teaches: only what was judged, and no colour from a screen that had none. */
export function judgedFeatures(card: Card, dimension?: Dimension, grey?: boolean): string[] {
  let fs = dimension === "value" ? valueFeatures(card.palette ?? []) : card.features;
  if (dimension) fs = fs.filter((f) => about(f, dimension));
  return grey ? fs.filter((f) => !isColourFeature(f)) : fs;
}

const COLOUR_TALK = /warm|cool|cold|colou?r|hue|tone|orange|blue|red\b|green|yellow|pink|sallow|pale|muddy|icy|washed/i;

/**
 * The card as it can be shown under these options, or null if it can't be judged there. Nothing is changed for good:
 * a reaction names the card's id and what was judged, and the stored card stays as it was written.
 */
export function dealable(card: Card, opts: DealOptions = {}): Card | null {
  const dimension = dimensionOf(card, opts);
  if (opts.still && dimension === "motion") return null;
  if (!opts.grey) return card;
  if (card.kind === "palette") {
    const features = valueFeatures(card.palette ?? []);
    return features.length ? { ...card, palette: (card.palette ?? []).map(greyOf), features } : null;
  }
  if (card.kind === "artifact" && card.artifact) {
    const axes = card.artifact.axes.filter((a) => !isColourFeature(a.feature));
    if (!axes.length) return null;
    if (axes.length === card.artifact.axes.length) return card;
    const hunch = COLOUR_TALK.test(card.artifact.hunch) ? "something here is off, and part of it is colour this screen can't show." : card.artifact.hunch;
    return { ...card, artifact: { ...card.artifact, axes, hunch } };
  }
  return card.features.length && !judgedFeatures(card, dimension, true).length ? null : card;
}

// ---------- a pair that varies one thing ----------
/** Set in both faces of a type pair: plain lines that favour neither. Made up here. */
const SAME_WORDS: readonly [string, string][] = [
  ["The river keeps its own slow time.", "A few small words sit underneath, so you can see how the lettering reads once the first glance is over."],
  ["Bring a coat and an open mind.", "A few small words sit underneath, so you can see how the lettering reads once the first glance is over."],
  ["We found the old map in a drawer.", "A few small words sit underneath, so you can see how the lettering reads once the first glance is over."],
  ["The bread is out at seven.", "A few small words sit underneath, so you can see how the lettering reads once the first glance is over."],
  ["Nothing much happened, and it was good.", "A few small words sit underneath, so you can see how the lettering reads once the first glance is over."],
];

const BUNDLED = /fraunces|literata|instrument sans|jetbrains mono|system-ui/i;
/** The face a stack is sure to draw with: only the bundled fonts and the system's own are on every device. */
function sureFace(stack: string): string {
  for (const raw of stack.split(",")) {
    const m = BUNDLED.exec(raw);
    if (m) return m[0].toLowerCase();
  }
  return stack.toLowerCase();
}

/** Would this pair ask something real? Two faces that draw the same, or two tones that read the same, ask nothing. */
export function canPair(a: Card, b: Card, opts: DealOptions = {}): boolean {
  if (a.id === b.id || a.kind !== b.kind) return false;
  const d = dimensionOf(a, opts);
  if (judgedFeatures(a, d, opts.grey).length + judgedFeatures(b, d, opts.grey).length === 0) return false;
  if (d === "type") {
    if (!a.type || !b.type) return false;
    // the big line has to look different: a pair that differs only in the small print asks nothing you can see at a glance
    return sureFace(a.type.display) !== sureFace(b.type.display);
  }
  if (d === "value") {
    const [x, y] = [tones(a.palette ?? []), tones(b.palette ?? [])];
    if (!x || !y || valueFeatures(a.palette ?? []).join() === valueFeatures(b.palette ?? []).join()) return false;
    // far enough apart to see, not just either side of a line
    return Math.abs(x.mean - y.mean) >= 0.12 || Math.abs(x.range - y.range) >= 0.2;
  }
  if (d === "motion" && a.motion && b.motion) return a.motion.duration !== b.motion.duration || a.motion.easing !== b.motion.easing || a.motion.amplitude !== b.motion.amplitude;
  return true;
}

function smallHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Everything but the judged thing made the same. The dealt copies only: the stored cards keep their own words. */
export function samePair(a: Card, b: Card, opts: DealOptions = {}): [Card, Card] {
  const d = dimensionOf(a, opts);
  if (d === "type" && a.type && b.type) {
    const [sample, blurb] = SAME_WORDS[smallHash([a.id, b.id].sort().join("|")) % SAME_WORDS.length];
    return [{ ...a, blurb, type: { ...a.type, sample } }, { ...b, blurb, type: { ...b.type, sample } }];
  }
  if (d === "motion" && a.motion && b.motion) return [a, { ...b, motion: { ...b.motion, scene: a.motion.scene } }];
  return [a, b];
}
