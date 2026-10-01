import { useEffect, useRef, type ReactNode } from "react";

/** Native prompts are unreliable in mobile WebViews. Keep focus in the dialog. */
export default function SurfaceModal({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const siblings = [...(root.current?.parentElement?.children ?? [])].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== root.current && !el.inert);
    siblings.forEach((el) => { el.inert = true; });
    root.current?.querySelector<HTMLElement>("input, button")?.focus();
    return () => { siblings.forEach((el) => { el.inert = false; }); previous?.focus(); };
  }, []);
  return <div ref={root} className="surface-modal" onKeyDown={(e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    if (e.key === "Tab") {
      const controls = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']")];
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  }}>{children}</div>;
}
