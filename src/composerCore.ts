/** Ordinary attachments must be uploaded before sending. */
export function attachmentBlocksSend(file: {
  state: "uploading" | "ready" | "error";
  media?: unknown;
}): boolean {
  return file.state !== "ready" || !file.media;
}

/** Touch keyboards own Enter; viewport width is not a keyboard capability. */
export function enterInsertsNewline(maxTouchPoints: number, coarsePointer: boolean): boolean {
  return maxTouchPoints > 0 || coarsePointer;
}

/** Voice deliveries must never be consumed by the draft's manual Send. */
export function manualAttachments<T extends { voice?: unknown }>(files: T[]): T[] {
  return files.filter((file) => !file.voice);
}
