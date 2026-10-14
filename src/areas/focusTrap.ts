// T-124 r15: one focus trap for the app's dialogs (the task sheet, the Places drawer). Tab and Shift+Tab wrap among the controls that can
// actually be reached: never one inside a closed <details> (its summary excepted), a hidden one or a disabled one. WebKitGTK still gives a
// closed <details>' content a size, so the check reads the open state itself rather than trusting layout.
const CANDIDATES = "button:not(:disabled), summary, a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']";

/** Whether a control can take focus where it stands: every <details> around it is open (or it is that details' own summary), and it is drawn. */
export function reachable(el: HTMLElement): boolean {
  for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) {
    if (!d.open && !(el.tagName === "SUMMARY" && el.parentElement === d)) return false;
  }
  if (el.closest("[hidden], [inert]")) return false;
  return el.getClientRects().length > 0;
}

/** The controls Tab moves among, in order. */
export const focusables = (box: HTMLElement): HTMLElement[] => [...box.querySelectorAll<HTMLElement>(CANDIDATES)].filter(reachable);

/** On Tab: wrap from the last reachable control to the first, and on Shift+Tab from the first (or the box itself) to the last. */
export function trapTab(e: { key: string; shiftKey: boolean; preventDefault: () => void }, box: HTMLElement | null): void {
  if (e.key !== "Tab" || !box) return;
  const f = focusables(box);
  if (!f.length) return;
  const at = document.activeElement;
  const inside = !!at && box.contains(at) && f.includes(at as HTMLElement);
  if (e.shiftKey && (at === f[0] || at === box || !inside)) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && (at === f[f.length - 1] || !inside && at !== box)) { e.preventDefault(); f[0].focus(); }
}
