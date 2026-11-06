// Is this screen greyscale? Asked of the screen itself where it can say (a monochrome display, the app's ink screen), then
// of the device's model (the Daylight, whose screen tells the browser it has colour). A choice made in the Arcade wins, and
// it is this device's own: kept in this browser, never sent anywhere. Only the ink screen can't be switched off from here:
// the host draws it in grey, so what's seen on it is seen in grey, whatever was chosen before.
import { useCallback, useEffect, useState } from "react";

const KEY = "ta-grey";
/** The Daylight's model name as device listings give it. Only ever read to choose the look of the games. */
const GREY_MODELS = /(^|[^a-z0-9])(dc-?1|daylight)([^a-z0-9]|$)/i;

export type GreyWhy = "ink" | "monochrome" | "model";

export function greyModel(text: string | null | undefined): boolean {
  return !!text && GREY_MODELS.test(text);
}

function readChoice(): "on" | "off" | null {
  try { const v = localStorage.getItem(KEY); return v === "on" || v === "off" ? v : null; } catch { return null; }
}

function monochrome(): boolean {
  return typeof matchMedia === "function" && matchMedia("(monochrome)").matches;
}

type UaData = { getHighEntropyValues?(hints: string[]): Promise<{ model?: string }> };

/** `ink`: the host's ink screen is on. Returns whether to play in greyscale, why it was found, and the switch. */
export function useGreyscale(ink: boolean): { grey: boolean; found: GreyWhy | null; locked: boolean; set(on: boolean): void } {
  const [choice, setChoice] = useState(readChoice);
  // a browser that hides the model from its user agent can still give it when asked, a moment later
  const [model, setModel] = useState(() => typeof navigator !== "undefined" && greyModel(navigator.userAgent));
  useEffect(() => {
    if (model) return;
    let live = true;
    const ua = (navigator as unknown as { userAgentData?: UaData }).userAgentData;
    ua?.getHighEntropyValues?.(["model"]).then((v) => { if (live && greyModel(v.model)) setModel(true); }, () => undefined);
    return () => { live = false; };
  }, [model]);
  const found: GreyWhy | null = ink ? "ink" : monochrome() ? "monochrome" : model ? "model" : null;
  const set = useCallback((on: boolean) => {
    const v = on ? "on" : "off";
    try { localStorage.setItem(KEY, v); } catch { /* this visit only */ }
    setChoice(v);
  }, []);
  return { grey: ink || (choice ? choice === "on" : !!found), found, locked: ink, set };
}
