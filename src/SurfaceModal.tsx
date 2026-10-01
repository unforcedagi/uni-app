import { useEffect, useRef, type ReactNode } from "react";

/** Native prompts are unreliable in mobile WebViews. Keep focus in the dialog. */
export default function SurfaceModal({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const siblings = [...(root.current?.parentElement?.children ?? [])].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== root.current && !el.inert && !el.classList.contains("recording-pill"));
    siblings.forEach((el) => { el.inert = true; });
    root.current?.querySelector<HTMLElement>("input, button")?.focus();
    return () => { siblings.forEach((el) => { el.inert = false; }); previous?.focus(); };
  }, []);
  return <div ref={root} className="surface-modal" onKeyDown={(e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    if (e.key === "Tab") {
      const controls = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']"), ...document.querySelectorAll<HTMLElement>(".recording-pill button:not(:disabled)")];
      const at = controls.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      controls[(at + (e.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }
  }}>{children}</div>;
}
