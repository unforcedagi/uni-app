// T-335 cards expand (11-11): where the card an ask points at stands (`sealed_card`). Aaron had two asks telling him to tap production cards
// that had ended at the broker an hour before. The card is read from the ask's own room as this device holds it: a card the broker ended is
// edited to one line with no fence (its words say how it ended); one still fenced is checked by Rust (`sealed_card`): waiting, answered here,
// expired or refused; a card in Needs you's waiting list (any room, any thread) is waiting. Read again after any answer (SEALED_CHANGED), when the window comes back, and when its answer-by time passes.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { cardIs, cardState, sealedFence, SEALED_CHANGED, type CardState, type SealedCardView, type SealedWaiting } from "../sealedCardCore";
import type { Ask } from "./types";

type Msg = { ref: string; channel: string; body: string };

export function useAskCard(ask: Pick<Ask, "room" | "sealedCard">): CardState | null {
  const { room, sealedCard } = ask;
  const [st, setSt] = useState<CardState | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    const bump = () => setAgain((n) => n + 1);
    window.addEventListener(SEALED_CHANGED, bump);
    window.addEventListener("focus", bump);
    return () => { window.removeEventListener(SEALED_CHANGED, bump); window.removeEventListener("focus", bump); };
  }, []);
  useEffect(() => {
    if (!room || !sealedCard) { setSt(null); return; }
    let live = true;
    setSt((s) => s ?? { state: "checking" });
    (async () => {
      // a card waiting anywhere on this device (another room, a thread) is waiting, wherever the ask lives
      const waiting = await invoke<SealedWaiting[]>("sealed_waiting").catch(() => [] as SealedWaiting[]);
      const w = Array.isArray(waiting) ? waiting.find((x) => cardIs(sealedCard, x.ref)) : undefined;
      if (w && w.expires > Date.now() / 1000) { if (live) setSt({ state: "waiting", channel: w.channel, ref: w.ref, expires: w.expires }); return; }
      const rows = await invoke<Msg[]>("get_messages", { channel: room, root: null, limit: 300 }).catch(() => null);
      if (!live || rows === null) return;
      const msg = rows.find((m) => cardIs(sealedCard, m.ref)) ?? null;
      const view = msg && sealedFence(msg.body) ? await invoke<SealedCardView | null>("sealed_card", { channel: msg.channel, reference: msg.ref }).catch(() => null) : null;
      if (live) setSt(cardState(msg, view && Array.isArray(view.rows) ? view : null, Date.now() / 1000));
    })();
    return () => { live = false; };
  }, [room, sealedCard, again]);
  // a waiting card's answer-by time: read again once it passes
  const until = st?.state === "waiting" ? st.expires : null;
  useEffect(() => {
    if (until === null) return;
    const t = window.setTimeout(() => setAgain((n) => n + 1), Math.max(0, Math.min(2 ** 31 - 1, (until - Date.now() / 1000) * 1000 + 500)));
    return () => window.clearTimeout(t);
  }, [until]);
  return st;
}
