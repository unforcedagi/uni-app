import type { MediaRef } from "./Attachments";

export type VoiceClip = {
  id: string; key: string; file: Blob; filename: string; mime: string;
  owner: string; relay: string; created: number; state: "uploading" | "error" | "delivered"; error?: string;
  media?: MediaRef; signedEvent?: string;
  voice: { channel: string; replyTo: string | null; notifyUni: boolean };
};

// Serialize transactions, including deletion, so a late write cannot resurrect a clip.
export class VoiceOutbox {
  private database: Promise<IDBDatabase> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private memoryOnly = false;
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
        // Only an unavailable database at startup permits memory-only delivery.
        // Once opened, transaction failures must never silently fall back.
        let db: IDBDatabase;
        try { db = await this.db(); } catch {
          this.memoryOnly = true;
          this.unavailable();
          return fallback();
        }
        return await new Promise<T>((resolve, reject) => {
          const transaction = db.transaction("clips", mode);
          const request = action(transaction.objectStore("clips"));
          transaction.oncomplete = () => resolve(request.result);
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
        });
      } catch {
        throw new Error("Couldn’t save the voice note safely — Retry");
      }
    });
    this.tail = job.catch(() => {});
    return job;
  }
  async put(clip: VoiceClip) {
    try {
      await this.run("readwrite", store => store.put(clip), () => clip.id);
      this.memory.set(clip.id, clip);
      return this.memoryOnly ? "memory" as const : "durable" as const;
    } catch { return "failed" as const; }
  }
  async remove(id: string) {
    try {
      await this.run("readwrite", store => store.delete(id), () => undefined);
      this.memory.delete(id);
      return this.memoryOnly ? "memory" as const : "durable" as const;
    } catch { return "failed" as const; }
  }
  async clear() {
    await this.run("readwrite", store => store.clear(), () => undefined);
    this.memory.clear();
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
