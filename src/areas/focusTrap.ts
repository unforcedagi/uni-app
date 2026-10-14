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

// ------------------------------------------------------------------------------------------------- r19
/** The dialogs open now, top last: Escape and Tab belong to the top one only (r19, one contract for every foreground surface). */
const stack: symbol[] = [];
export const dialogOpen = (): boolean => stack.length > 0;
/**
 * One dialog contract (r19, Codex 5): the task sheet, the companion's sheet, the Places drawer and the utility panels (Search, Settings, Vault).
 * While `open`: focus moves in (the box itself, or `initial`), Tab wraps among its reachable controls, everything around it is inert (`keep`:
 * elements left live, the rail that switches the panels), and Escape closes it, only when it is the top dialog, before any other handler sees
 * the key. On close, focus goes back to what opened it (when that is still there and focus would otherwise be lost).
 */
export function isolate(box: HTMLElement, keep: readonly (Element | null)[] = []): () => void {
  const marked: Element[] = [];
  const live = (el: Element) => keep.some((k) => k && (k === el || el.contains(k) || k.contains(el)));
  for (let el: Element | null = box; el && el !== document.body; el = el.parentElement) {
    for (const sib of el.parentElement?.children ?? []) if (sib !== el && !live(sib) && !sib.hasAttribute("inert") && sib.tagName !== "SCRIPT") { sib.setAttribute("inert", ""); marked.push(sib); }
  }
  return () => { for (const m of marked) m.removeAttribute("inert"); };
}
export function openDialog(box: HTMLElement, close: () => void, opts: { /** what stays live beside it */ keep?: readonly (Element | null)[]; initial?: HTMLElement | null; opener?: HTMLElement | null;
  /** the dialog's whole layer (its scrim included), isolated from everything else; default the box */ root?: HTMLElement | null } = {}): () => void {
  const me = Symbol("dialog"); stack.push(me);
  const opener = opts.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const undo = isolate(opts.root ?? box, opts.keep);
  if (!box.contains(document.activeElement)) (opts.initial ?? box).focus();
  const key = (e: KeyboardEvent) => {
    if (stack[stack.length - 1] !== me) return;
    if (e.key === "Escape") { if (e.defaultPrevented) return; e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Tab") trapTab(e, box);
  };
  window.addEventListener("keydown", key, true);
  return () => {
    window.removeEventListener("keydown", key, true);
    const i = stack.indexOf(me); if (i >= 0) stack.splice(i, 1);
    undo();
    const at = document.activeElement;
    if (opener?.isConnected && (!at || at === document.body || box.contains(at) || !at.isConnected)) opener.focus();
  };
}
