// Small shared hooks: calm mode (reduced motion or the ink screen), media URLs, saving reactions with retry, a soft tick.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Card, DealOptions, GameId, Reaction, ReactionKind } from "../../../engine/src/types.ts";
import type { ArcadeHost } from "../host.ts";
import { newId } from "../host.ts";

export interface ArcadeCtx {
  host: ArcadeHost;
  /** reduced motion or the ink screen: no motion at all */
  calm: boolean;
  ink: boolean;
  /** back to the Arcade home */
  home(): void;
  /** "Uni" in the app; in the cloud the machine has no name */
  uni: string | null;
  /** This or That's burst, in seconds */
  burstSeconds: number;
  /** this screen shows no colour: what's dealt changes, and every reaction is marked */
  grey: boolean;
  setGrey(on: boolean): void;
  /** what to ask the host for, from grey and calm */
  deal: DealOptions;
}

export const Ctx = createContext<ArcadeCtx | null>(null);

export function useArcade(): ArcadeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useArcade outside <Arcade>");
  return c;
}

function readInk(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-screen") === "ink";
}

/** The ink screen (the Daylight): the app sets :root[data-screen="ink"]. Watched, since it can change while playing. */
export function useInk(): boolean {
  const [ink, setInk] = useState(readInk);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => setInk(readInk()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-screen"] });
    return () => mo.disconnect();
  }, []);
  return ink;
}

const reduceQuery = () => (typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null);

export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => !!reduceQuery()?.matches);
  useEffect(() => {
    const q = reduceQuery();
    if (!q) return;
    const on = () => setReduce(q.matches);
    on();
    q.addEventListener?.("change", on);
    return () => q.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

/** A URL for a card's media from the host. The host owns the URL: nothing here revokes it. */
export function useMediaUrl(card: Card | null | undefined, which: "src" | "poster" = "src"): { url: string | null; state: "loading" | "ready" | "none" } {
  const { host } = useArcade();
  const [out, setOut] = useState<{ url: string | null; state: "loading" | "ready" | "none" }>({ url: null, state: "loading" });
  const id = card?.id;
  const has = which === "src" ? !!card?.media?.src : !!card?.media?.poster;
  useEffect(() => {
    if (!card || !has) { setOut({ url: null, state: "none" }); return; }
    let live = true;
    setOut({ url: null, state: "loading" });
    host.mediaUrl(card, which).then(
      (url) => { if (live) setOut({ url, state: url ? "ready" : "none" }); },
      () => { if (live) setOut({ url: null, state: "none" }); },
    );
    return () => { live = false; };
    // the card id is what matters: a new object for the same card needs no new URL
  }, [host, id, which, has]);
  return out;
}

export function reaction(game: GameId, kind: ReactionKind, card: string, extra: Partial<Reaction> = {}): Reaction {
  return { id: newId(), at: new Date().toISOString(), game, kind, card, ...extra };
}

/**
 * Saves reactions to the host, keeping a session list for the burst's end. A failed save is kept and retried (ids are
 * stable, so a retry never doubles); the game keeps playing either way.
 */
export function useSaver() {
  const { host, grey } = useArcade();
  const [session, setSession] = useState<Reaction[]>([]);
  const [failed, setFailed] = useState<Reaction[]>([]);
  const [busy, setBusy] = useState(false);
  const failedRef = useRef<Reaction[]>([]);
  failedRef.current = failed;

  const send = useCallback(async (rs: Reaction[]) => {
    if (!rs.length) return true;
    setBusy(true);
    try {
      await host.react(rs);
      return true;
    } catch {
      setFailed((f) => [...f, ...rs.filter((r) => !f.some((x) => x.id === r.id))]);
      return false;
    } finally {
      setBusy(false);
    }
  }, [host]);

  const save = useCallback((rs: Reaction[]) => {
    // seen on a screen with no colour: said on the reaction, so colour taste isn't learned from it
    const marked = grey ? rs.map((r) => ({ ...r, grey: true })) : rs;
    setSession((s) => [...s, ...marked]);
    return send(marked);
  }, [send, grey]);

  const retry = useCallback(async () => {
    const list = failedRef.current;
    setFailed([]);
    return send(list);
  }, [send]);

  /** a new burst: the end screen counts only what happens from here */
  const clear = useCallback(() => setSession([]), []);

  return { session, save, retry, clear, failed: failed.length, busy };
}

let audio: AudioContext | null = null;
/** A soft wooden tick: a short filtered blip, quiet. Only after a tap (browsers allow sound then). */
export function tick(pitch = 1): void {
  try {
    const AC = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    audio = audio ?? new AC();
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(880 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(440 * pitch, t + 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.14);
  } catch {
    /* no sound is fine */
  }
}

/** Keys for a game, ignored while typing in a field. */
export function useKeys(handler: (e: KeyboardEvent) => void, on = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!on) return;
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      ref.current(e);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [on]);
}

/** A stable small number from a string, for drawing (waveforms, tilts) that stays the same per card. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
