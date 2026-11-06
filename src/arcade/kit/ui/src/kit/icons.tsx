// One small icon set, drawn here: 24-unit grid, 1.8 stroke, round ends. Decorative unless given a title.
import type { ReactNode } from "react";

type P = { size?: number; className?: string };

function I({ size = 22, className, children }: P & { children: ReactNode }) {
  return (
    <svg className={`ta-icon${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const Back = (p: P) => <I {...p}><path d="M10 6 4 12l6 6" /><path d="M4.5 12H14c3.3 0 6 2.2 6 5.5" /></I>;
export const Next = (p: P) => <I {...p}><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></I>;
export const Seed = (p: P) => <I {...p}><path d="M12 3c4 3.5 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0C6.5 10 8 6.5 12 3Z" /><path d="M12 9.5v8" /></I>;
export const Pin = (p: P) => <I {...p}><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.3" /></I>;
export const Play = (p: P) => <I {...p}><path d="M8 5.5v13l10.5-6.5L8 5.5Z" fill="currentColor" /></I>;
export const Pause = (p: P) => <I {...p}><path d="M8.5 5.5v13M15.5 5.5v13" strokeWidth={3} /></I>;
export const SoundOn = (p: P) => <I {...p}><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></I>;
export const SoundOff = (p: P) => <I {...p}><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></I>;
export const Mic = (p: P) => <I {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></I>;
export const Check = (p: P) => <I {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></I>;
export const Cross = (p: P) => <I {...p}><path d="M6 6l12 12M18 6 6 18" /></I>;
export const Pen = (p: P) => <I {...p}><path d="M14.5 4.5 19.5 9.5 9 20H4v-5L14.5 4.5Z" /><path d="m12.5 6.5 5 5" /></I>;
export const Spark = (p: P) => <I {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></I>;
export const Can = (p: P) => <I {...p}><path d="M5 10h10v8.5A1.5 1.5 0 0 1 13.5 20h-7A1.5 1.5 0 0 1 5 18.5V10Z" /><path d="M15 12.5 20.5 8M5 12c-1.7 0-2.5-1-2.5-2.5S3.5 7 5 7h3" /><path d="M20 4.5v.01M21.5 6.5v.01" /></I>;
export const Shears = (p: P) => <I {...p}><circle cx="6.5" cy="17.5" r="2.8" /><circle cx="17.5" cy="17.5" r="2.8" /><path d="M8.5 15.5 18 4M15.5 15.5 6 4" /></I>;
export const Hand = (p: P) => <I {...p}><path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11.5V5a1.5 1.5 0 0 1 3 0v6.5M14 11.5V6.5a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6.5 7-2.6 0-4.2-1.2-5.6-3.4L3.4 14a1.5 1.5 0 0 1 2.4-1.8L8 15" /></I>;
export const Download = (p: P) => <I {...p}><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" /></I>;
export const Note = (p: P) => <I {...p}><path d="M6 3.5h8.5L19 8v12.5H6V3.5Z" /><path d="M14 3.5V8.5h5M9 13h7M9 16.5h5" /></I>;
export const Undo = (p: P) => <I {...p}><path d="M9 7 4.5 11.5 9 16" /><path d="M5 11.5h9.5a5 5 0 0 1 0 10H12" /></I>;
export const Keyboard = (p: P) => <I {...p}><rect x="3" y="6.5" width="18" height="11" rx="2" /><path d="M7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17 10.5h.01M8 14h8" /></I>;
