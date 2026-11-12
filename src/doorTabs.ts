// T-335: the doors' tab strip (Messages' networks, Mail's places), one behaviour for both: the tab you're on stays in
// sight when the strip scrolls sideways (a phone), and the arrow keys move along the tabs. The look is doors.css.
import { useLayoutEffect, type KeyboardEvent, type RefObject } from "react";

/** `strip`: the element that scrolls sideways and holds the tabs (each `[data-tab=<id>]`). Returns the tablist's
 *  keydown handler. */
export function useDoorTabs<T extends string>(strip: RefObject<HTMLElement | null>, ids: T[], current: T, onPick: (id: T) => void) {
  useLayoutEffect(() => {
    const el = strip.current, on = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !on) return;
    // the strip alone scrolls: nothing around it moves
    const left = on.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft, right = left + on.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }, [current]);
  return (e: KeyboardEvent<HTMLElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step || ids.length === 0) return;
    e.preventDefault();
    const at = ids.indexOf(current);
    // the current tab may have just gone (a Refresh): the arrows start from either end
    const next = at < 0 ? ids[step > 0 ? 0 : ids.length - 1] : ids[(at + step + ids.length) % ids.length];
    onPick(next);
    strip.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };
}
