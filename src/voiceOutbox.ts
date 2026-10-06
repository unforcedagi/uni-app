import type { MediaRef } from "./Attachments";

export type VoiceClip = {
  id: string; key: string; file: Blob; filename: string; mime: string;
  created: number; state: "uploading" | "error"; error?: string;
  media?: MediaRef; signedEvent?: string;
  voice: { channel: string; replyTo: string | null; notifyUni: boolean };
};

// Serialize transactions, including deletion, so a late write cannot resurrect a clip.
export class VoiceOutbox {
  private database: Promise<IDBDatabase> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private memory = new Map<string, VoiceClip>();
  constructor(private unavailable: () => void) {}
  private db() {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("uni-voice-outbox", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("clips", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Voice outbox storage is blocked"));
    });
  }
  private run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>, fallback: () => T): Promise<T> {
    const job = this.tail.then(async () => {
      try {
        const db = await this.db();
        return await new Promise<T>((resolve, reject) => {
          const transaction = db.transaction("clips", mode);
          const request = action(transaction.objectStore("clips"));
          transaction.oncomplete = () => resolve(request.result);
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
        });
      } catch {
        this.unavailable();
        return fallback();
      }
    });
    this.tail = job.catch(() => {});
    return job;
  }
  async put(clip: VoiceClip) {
    this.memory.set(clip.id, clip);
    await this.run("readwrite", store => store.put(clip), () => clip.id);
  }
  async remove(id: string) {
    this.memory.delete(id);
    await this.run("readwrite", store => store.delete(id), () => undefined);
  }
  async list() {
    const clips = await this.run("readonly", store => store.getAll() as IDBRequest<VoiceClip[]>, () => [...this.memory.values()]);
    for (const clip of clips) this.memory.set(clip.id, clip);
    return clips.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  }
}

export function relayAccepted(error: unknown): boolean {
  return typeof error === "object" && error !== null && "accepted" in error && error.accepted === true && "eventId" in error && typeof error.eventId === "string";
}
