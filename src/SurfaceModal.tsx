import { useEffect, useRef, type ReactNode } from "react";
import { openDialog } from "./areas/focusTrap";

/**
 * Native prompts are unreliable in mobile WebViews: the app's own small dialogs (New note, confirmations). r21 (Codex 4): one dialog contract
 * with every other foreground surface (`openDialog`): focus in, Tab kept inside, what is under it inert (the recording pill stays live),
 * Escape on the top dialog only, and focus back to what opened it.
 */
export default function SurfaceModal({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel); cancelRef.current = onCancel;
  useEffect(() => {
    const box = root.current; if (!box) return;
    return openDialog(box, () => cancelRef.current(), { keep: [document.querySelector(".recording-pill")], initial: box.querySelector<HTMLElement>("input, button") });
  }, []);
  // keys typed here are the dialog's, never the app's shortcuts
  return <div ref={root} className="surface-modal" onKeyDown={(e) => e.stopPropagation()}>{children}</div>;
}
