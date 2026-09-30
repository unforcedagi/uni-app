// One recording at a time across the app (composer and Journal each have a
// recorder). Pure, unit-tested.

export class RecordingBusy extends Error {}

let holder: { token: object; label: string } | null = null;

/** Claim the microphone for `token`; throws RecordingBusy naming who has it. */
export function claimRecording(token: object, label: string): void {
  if (holder && holder.token !== token) throw new RecordingBusy(`Already recording ${holder.label}. Stop that recording first.`);
  holder = { token, label };
}

export function releaseRecording(token: object): void {
  if (holder?.token === token) holder = null;
}

/** Who is recording, if anyone. */
export function recordingHolder(): string | null {
  return holder?.label ?? null;
}
