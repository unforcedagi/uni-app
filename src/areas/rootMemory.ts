/** Whether Uni's own level is open rather than its home (T-302: the front door; a phone without chat: the room tree). A replace of the
 *  surface remounts the page, so this outlives it; the App sets it when Uni's room is opened from anywhere else, and clears it when the
 *  rail's Uni (or a Back to Uni) asks for the home. An open surface follows every change. */
export const rootOpenMemory = { open: false };
const listeners = new Set<(open: boolean) => void>();
export function setRootOpenMemory(open: boolean) {
  rootOpenMemory.open = open;
  for (const l of listeners) l(open);
}
export const onRootOpen = (l: (open: boolean) => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
