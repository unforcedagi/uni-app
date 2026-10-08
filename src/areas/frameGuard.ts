// Host-side guards for the sealed frame (pure; AreaFrame wires them to the DOM).

/** The text shown in place of a frame that loaded a second document. */
export const STOPPED_MESSAGE = "This area app tried to leave its sandbox and was stopped.";

/**
 * A srcdoc frame fires `load` exactly once. A second `load` means the frame
 * navigated (self-navigation, meta refresh, a clicked link, document.write of a
 * redirect), so the host unmounts it. This is the second line of defence behind
 * the host CSP `frame-src about:`.
 */
export class LoadTripwire {
  private loads = 0;
  /** Count one `load`; true once the frame has loaded more than once. */
  load(): boolean { this.loads++; return this.loads > 1; }
  get count(): number { return this.loads; }
  reset(): void { this.loads = 0; }
}

export const GESTURE_WINDOW_MS = 5000;

/**
 * Did the user just act inside the frame? The host cannot see clicks inside a
 * sandboxed frame, so it uses two things it can see: focus is in the iframe
 * (a tap on the host's own UI leaves it elsewhere) and the window has a live
 * transient user activation (activation in a subframe propagates up to its
 * ancestors). Without `navigator.userActivation`, focus having entered the
 * frame within the window stands in.
 */
export function gestureFresh(s: { iframeFocused: boolean; userActive: boolean | null; focusedAt: number | null; now: number }): boolean {
  if (!s.iframeFocused) return false;
  if (s.userActive !== null) return s.userActive;
  return s.focusedAt !== null && s.now - s.focusedAt <= GESTURE_WINDOW_MS;
}
