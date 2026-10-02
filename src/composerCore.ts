/** Audio readiness depends on upload, not transcription. Failed voice clips
 * may be omitted only by the composer's explicitly labelled transcript send. */
export function attachmentBlocksSend(file: {
  state: "uploading" | "ready" | "error";
  media?: unknown;
  voice?: "transcribing" | "done" | "failed";
}): boolean {
  return (file.state !== "ready" && !(file.voice && file.state === "error")) || (file.state === "ready" && !file.media);
}

/** Touch keyboards own Enter; viewport width is not a keyboard capability. */
export function enterInsertsNewline(maxTouchPoints: number, coarsePointer: boolean): boolean {
  return maxTouchPoints > 0 || coarsePointer;
}
