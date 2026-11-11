// T-335 Taste Arcade in the app: the games (vendored from the taste-arcade library, src/arcade/kit) over the arcade door.
// The Arcade is an applet on contract 2 (./manifest.ts): everything it reaches goes through the applet port the shell
// hands it (src/interface/port.ts), which refuses what its grant doesn't name. This folder imports no Tauri
// (scripts/appletV2.test.ts). Behind the port every door call is NIP-98 signed in Rust with the device key; Ripple's
// answers go into the journal the same way the Journal's own entries do, and the reaction carries only where the
// entry landed.
import { useEffect, useMemo, useRef } from "react";
import { Arcade } from "./kit/ui/src/index.ts";
import type { ArcadeHost, PlayGame, VoiceCapture } from "./kit/ui/src/index.ts";
import type { LookPin } from "./kit/ui/src/host.ts"; // (the library's index does not export it yet)
import type { Card, DealOptions, GameId, Profile, Reaction, Round, Stats } from "./kit/engine/src/types.ts";
import { RecorderSession } from "../recorderSession.ts";
import { newDraft, type FlushReport } from "../journalCore.ts";
import { arcadeError, journalRef, mediaType, typedAnswer } from "./arcadeCore.ts";
import type { AppletPort } from "../interface/port.ts";
import "./arcade-place.css";

const GAMES: GameId[] = ["this-or-that", "gallery", "fix-it", "who-said-it", "ripple", "garden"];

type Home = { stats: Stats; fresh?: Partial<Record<PlayGame, number>>; look?: LookPin[] };

/** Voice for Ripple: the app's own recorder session, saved as a journal voice entry. One recording at a time: a second
 *  start is refused, a second stop waits for the first, and cancel during a stop resolves it with nothing kept. */
export function journalVoice(save: (blob: Blob, mime: string) => Promise<string>, allowed: () => void = () => {}): VoiceCapture {
  let session: RecorderSession<null> | null = null;
  let done: ((v: { blob: Blob; mime: string } | null) => void) | null = null;
  let stopping: Promise<{ ref: string; seconds: number } | null> | null = null;
  let stoppingSession: RecorderSession<null> | null = null;
  // a recording that ended on its own (the mic went away) before stop was asked for
  let early: { blob: Blob; mime: string } | null = null;
  let t0 = 0;
  const end = () => { session?.dispose(); session = null; };
  return {
    async start() {
      if (session) throw new Error("already recording");
      allowed(); // throws unless the grant lets the Arcade record
      early = null;
      const s = new RecorderSession<null>((blob, mime) => { const d = done; done = null; if (d) d({ blob, mime }); else early = { blob, mime }; });
      session = s;
      try {
        if (!(await s.start(null, "in the Arcade"))) throw new Error("the microphone is busy with another recording");
      } catch (e) { if (session === s) end(); throw e; }
      t0 = Date.now();
    },
    stop() {
      // a second stop of this recording waits for the first; a recording started while the last one saves is its own
      if (stopping && (!session || session === stoppingSession)) return stopping;
      if (!session) return Promise.resolve(null);
      const s = session;
      stoppingSession = s;
      stopping = (async () => {
        try {
          const got = early ?? (s.phase === "idle" ? null : await new Promise<{ blob: Blob; mime: string } | null>((resolve) => { done = resolve; s.stop(); }));
          early = null;
          if (session === s) end();
          if (!got || got.blob.size < 200) return null;
          const seconds = (Date.now() - t0) / 1000; // the time spoken: taken before a slow save, and before a next recording's start
          return { ref: await save(got.blob, got.mime), seconds };
        } finally { if (stoppingSession === s) stopping = null; }
      })();
      return stopping;
    },
    cancel() {
      const d = done; done = null; d?.(null);
      session?.stop();
      end();
    },
  };
}

const saveVoiceEntry = (port: AppletPort) => async (blob: Blob, mime: string): Promise<string> => {
  const draft = newDraft("", "voice");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const r = await port.vault.create<FlushReport>("home", draft, { bytes, mime });
  if (r.error && r.remaining === 0) throw new Error(r.error);
  return journalRef(r, draft.path);
};

/** `look`: a room's look-here link to open (App, from src/openLink.ts); `n` counts the taps, so a second tap opens it again. */
export function ArcadeView({ port, ownerName, onBack, look }: { /** The Arcade's one way out: every call is checked against its grant. */ port: AppletPort; ownerName: string | null; onBack?: () => void; look?: { card: string; n: number } | null }) {
  const urls = useRef(new Map<string, Promise<string | null>>());
  useEffect(() => () => {
    for (const p of urls.current.values()) void p.then((u) => { if (u) URL.revokeObjectURL(u); });
    urls.current.clear();
  }, []);
  const voice = useMemo(() => journalVoice(saveVoiceEntry(port), () => port.need("voice")), [port]);
  // a typed Ripple answer is filed as a journal entry; the door hears where it landed, never the words (as for voice)
  const typedRef = useRef(new Map<string, string>());
  // the home asks for stats and fresh together: stats share the answer fresh asked for
  const lastDeal = useRef<DealOptions | undefined>(undefined);
  const host = useMemo<ArcadeHost>(() => {
    const call = async <T,>(op: string, args?: Record<string, unknown>): Promise<T> => {
      try { return await port.door<T>("arcade", op, args); } catch (e) { throw new Error(arcadeError(e)); }
    };
    const screen = (o?: DealOptions) => ({ grey: !!o?.grey, still: !!o?.still });
    let home: Promise<Home> | null = null;
    let homeFor = "";
    const fetchHome = (o?: DealOptions) => {
      // a short cache for the home's two asks at once; another screen (the greyscale switch) is another answer
      const key = JSON.stringify(screen(o));
      if (key !== homeFor) { home = null; homeFor = key; }
      const mine: Promise<Home> = home ??= call<Home>("home", screen(o)).then(
        (h) => { setTimeout(() => { if (home === mine) home = null; }, 2000); return h; },
        (e) => { if (home === mine) home = null; throw e; },
      );
      return mine;
    };
    return {
      owner: { name: ownerName ?? "you", you: false },
      games: GAMES,
      // look: a pinned card's round first (the Arcade asks this once, for the pin it opens)
      rounds: async (game, n, o) => (await call<{ rounds: Round[] }>("rounds", { game, n, ...screen(o), ...(o?.look ? { look: o.look } : {}) })).rounds,
      react: async (reactions: Reaction[]) => {
        const out = reactions.map((r) => typedAnswer(r, typedRef.current)).filter((r): r is Reaction => r !== null);
        if (out.length) await call("react", { reactions: out });
        home = null;
      },
      profile: async () => (await call<{ profile: Profile }>("profile")).profile,
      stats: async () => (await fetchHome(lastDeal.current)).stats,
      fresh: async (o) => { lastDeal.current = o; return (await fetchHome(o)).fresh ?? {}; },
      // look here: the cards a room pinned, from the same /home answer
      look: async (o) => (await fetchHome(o)).look ?? [],
      mediaUrl: (card: Card, which: "src" | "poster") => {
        const name = which === "src" ? card.media?.src : card.media?.poster;
        if (!name) return Promise.resolve(null);
        const key = `${card.id}\n${which}`;
        let p = urls.current.get(key);
        if (!p) {
          p = port.door<ArrayBuffer>("arcade", "media", { card: card.id, which })
            .then((buf) => URL.createObjectURL(new Blob([buf], { type: mediaType(card, which) })))
            .catch(() => { urls.current.delete(key); return null; });
          urls.current.set(key, p);
        }
        return p;
      },
      voice,
      saveAnswer: async (q: Card, text: string) => {
        const draft = newDraft(text, "text");
        // the same words saved twice in the Arcade are two answers: never held back as a duplicate
        const r = await port.vault.create<FlushReport>("home", draft, undefined, { saveAnother: true });
        if (r.error && r.remaining === 0) throw new Error(r.error);
        const ref = journalRef(r, draft.path);
        typedRef.current.set(`${q.id}\n${text.trim()}`, ref);
        return { ref };
      },
      distill: async () => { await call("distill", { deep: false }); },
      openProfile: () => {
        void call<{ note: { vault: string; path: string } }>("profile").then((p) => port.open(p.note.vault, p.note.path)).catch(() => undefined);
      },
    };
  }, [ownerName, port, voice]);
  // the browser tests' build may shorten This or That's minute (VITE_AREAS_TESTHOOKS); a shipped build never reads it
  const burst = import.meta.env.VITE_AREAS_TESTHOOKS === "1" ? Number((window as { __arcadeBurst?: number }).__arcadeBurst) || undefined : undefined;
  // 0.2: the Arcade is a place on the rail: no Back of its own (a host without a rail can still pass one)
  return <div className="arcade-place"><Arcade key={look?.n ?? 0} host={host} onExit={onBack} burstSeconds={burst} look={look?.card} /></div>;
}
