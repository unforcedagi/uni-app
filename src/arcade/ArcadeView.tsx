// T-335 Taste Arcade in the app: the games (vendored from the taste-arcade library, src/arcade/kit) over the arcade door.
// Every call goes through Rust, NIP-98 signed with the device key; Ripple's voice answers go into the journal the same
// way the Journal's voice entries do (journal_save_voice), and the reaction carries only where the entry landed.
import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Arcade } from "./kit/ui/src/index.ts";
import type { ArcadeHost, PlayGame, VoiceCapture } from "./kit/ui/src/index.ts";
import type { Card, GameId, Profile, Reaction, Round, Stats } from "./kit/engine/src/types.ts";
import { RecorderSession } from "../recorderSession.ts";
import { newDraft, type FlushReport } from "../journalCore.ts";
import { arcadeError, journalRef, mediaType } from "./arcadeCore.ts";
import "./arcade-place.css";

const GAMES: GameId[] = ["this-or-that", "gallery", "fix-it", "who-said-it", "ripple", "garden"];

type Home = { stats: Stats; fresh?: Partial<Record<PlayGame, number>> };

/** Voice for Ripple: the app's own recorder session, saved as a journal voice entry. */
function journalVoice(): VoiceCapture {
  let session: RecorderSession<null> | null = null;
  let done: ((v: { blob: Blob; mime: string } | null) => void) | null = null;
  let t0 = 0;
  let dropped = false;
  return {
    async start() {
      dropped = false;
      session = new RecorderSession<null>((blob, mime) => { const d = done; done = null; d?.(dropped ? null : { blob, mime }); });
      const ok = await session.start(null, "in the Arcade");
      if (!ok) throw new Error("the microphone is busy with another recording");
      t0 = Date.now();
    },
    async stop() {
      if (!session) return null;
      const got = await new Promise<{ blob: Blob; mime: string } | null>((resolve) => { done = resolve; session!.stop(); });
      session.dispose();
      session = null;
      if (!got || got.blob.size < 200) return null;
      const seconds = (Date.now() - t0) / 1000;
      const draft = newDraft("", "voice");
      const bytes = new Uint8Array(await got.blob.arrayBuffer());
      const r = await invoke<FlushReport>("journal_save_voice", bytes, { headers: { "x-entry": JSON.stringify(draft), "x-audio-mime": got.mime } });
      return { ref: journalRef(r, draft.path), seconds };
    },
    cancel() {
      dropped = true;
      session?.stop();
      session?.dispose();
      session = null;
    },
  };
}

export function ArcadeView({ ownerName, onBack, onOpenNote }: { ownerName: string | null; onBack: () => void; onOpenNote: (vault: string, path: string) => void }) {
  const urls = useRef(new Map<string, Promise<string | null>>());
  useEffect(() => () => {
    for (const p of urls.current.values()) void p.then((u) => { if (u) URL.revokeObjectURL(u); });
    urls.current.clear();
  }, []);
  const host = useMemo<ArcadeHost>(() => {
    const call = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      try { return await invoke<T>(cmd, args); } catch (e) { throw new Error(arcadeError(e)); }
    };
    let home: Promise<Home> | null = null;
    const fetchHome = () => (home ??= call<Home>("arcade_home").finally(() => { setTimeout(() => { home = null; }, 2000); }));
    return {
      owner: { name: ownerName ?? "you", you: false },
      games: GAMES,
      rounds: async (game, n) => (await call<{ rounds: Round[] }>("arcade_rounds", { game, n })).rounds,
      react: async (reactions: Reaction[]) => { await call("arcade_react", { reactions }); home = null; },
      profile: async () => (await call<{ profile: Profile }>("arcade_profile")).profile,
      stats: async () => (await fetchHome()).stats,
      fresh: async () => (await fetchHome()).fresh ?? {},
      mediaUrl: (card: Card, which: "src" | "poster") => {
        const name = which === "src" ? card.media?.src : card.media?.poster;
        if (!name) return Promise.resolve(null);
        const key = `${card.id}\n${which}`;
        let p = urls.current.get(key);
        if (!p) {
          p = invoke<ArrayBuffer>("arcade_media", { card: card.id, which })
            .then((buf) => URL.createObjectURL(new Blob([buf], { type: mediaType(card, which) })))
            .catch(() => { urls.current.delete(key); return null; });
          urls.current.set(key, p);
        }
        return p;
      },
      voice: journalVoice(),
      saveAnswer: async (_q: Card, text: string) => {
        const draft = newDraft(text, "text");
        const r = await invoke<FlushReport>("journal_save_text", { entry: draft });
        return { ref: journalRef(r, draft.path) };
      },
      distill: async () => { await call("arcade_distill", { deep: false }); },
      openProfile: () => {
        void call<{ note: { vault: string; path: string } }>("arcade_profile").then((p) => onOpenNote(p.note.vault, p.note.path)).catch(() => undefined);
      },
    };
  }, [ownerName, onOpenNote]);
  // the browser tests' build may shorten This or That's minute (VITE_AREAS_TESTHOOKS); a shipped build never reads it
  const burst = import.meta.env.VITE_AREAS_TESTHOOKS === "1" ? Number((window as { __arcadeBurst?: number }).__arcadeBurst) || undefined : undefined;
  return <div className="arcade-place"><Arcade host={host} onExit={onBack} burstSeconds={burst} /></div>;
}
