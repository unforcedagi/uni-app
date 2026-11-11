// Contract v2: the applet port. A built-in applet reaches the box, the vault and the device only through the port the
// shell hands it, and the port asks the grant before every call. What the grant doesn't name is refused here, at
// runtime, with `not_granted` (the grant has no such door, vault or reach) or `out_of_scope` (it has, but not this
// op, note or folder). A read is judged on the note that comes back, never on what was asked for, and a note outside
// the grant reads as absent, so the port is no oracle for what exists.
//
// The boundary is one of construction: the applet's folder is written with no other way to a shell command, and
// scripts/appletV2.test.ts keeps it so (no Tauri, no command names, no network, no microphone, a short list of shell
// imports). docs/interfaces.md says what that does and doesn't cover. (A sealed applet's boundary is the frame and
// session.ts; this port is for code compiled into the app.)
// Pure: no React, no Tauri. The shell supplies the backends.

import { ContractError, ERROR_CODES } from "./contract.ts";
import { doorOp } from "./doors.ts";
import { allowsDoor, allowsNote, allowsQuery, allowsReach, type Grant } from "./grant2.ts";
import { HOME, type Verb } from "./manifest2.ts";

export type PortNote = { id?: unknown; path?: unknown; tags?: unknown; [k: string]: unknown };
/** A note to add: where it goes (and where else it may land if that path is taken), plus what the writer needs. */
export type NewNote = { path: string; alternates?: readonly string[]; [k: string]: unknown };

/** What the shell does once the port has said yes. Each is the shell's own code; the applet never sees them. */
export type PortBackends = {
  /** Run one shell command (a door op's `cmd`). */
  command(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  query(vault: string, q: { type?: string; pathPrefix?: string; limit: number; offset: number }): Promise<PortNote[]>;
  note(vault: string, ref: string): Promise<PortNote | null>;
  /** Can the shell's writer add notes to this vault right now? Rejects with the reason when it can't. */
  writable(vault: string): Promise<void>;
  /**
   * Add a note through the shell's writer (it queues offline and never doubles a retry). `made`: the ids or paths of the
   * notes the writer says this call created, empty when it can't say (queued, landed on another name, held as a duplicate).
   */
  create(vault: string, note: NewNote, audio?: { bytes: Uint8Array; mime: string }, opts?: { saveAnother?: boolean }): Promise<{ result: unknown; made: string[] }>;
  /** Show a note to the owner. */
  open(vault: string, path: string): void;
};

export type Refusal = { code: "not_granted" | "out_of_scope"; what: string };
export type PortOptions = {
  /** The name `home` stands for on this device. */
  home: string | null;
  /** Asked before every call: false once the grant is revoked or expired, or the applet's screen is gone. */
  live?: () => boolean;
  onRefused?: (r: Refusal) => void;
};

export function createAppletPort(grant: Grant, be: PortBackends, opts: PortOptions) {
  let closed = false;
  // the notes the shell's writer says this port added (ids or paths): `own` rules cover them, and nothing else
  const made = new Set<string>();
  const refuse = (code: Refusal["code"], what: string): never => {
    opts.onRefused?.({ code, what });
    throw new ContractError(code === "not_granted" ? ERROR_CODES.notGranted : ERROR_CODES.outOfScope, `${grant.applet.name} isn't allowed to ${what}`);
  };
  const check = () => { if (closed || opts.live?.() === false) refuse("not_granted", "do anything: its access has ended"); };
  /** The vault's real name, and whether the grant names that vault at all. */
  const vaultOf = (vault: string, what: string): string => {
    const name = vault === HOME ? opts.home : vault;
    if (!name || !grant.vaults.some((v) => v.vault === name)) refuse("not_granted", `${what} in the ${vault} vault`);
    return name!;
  };
  const facts = (n: PortNote) => ({ path: typeof n.path === "string" ? n.path : null, tags: Array.isArray(n.tags) ? n.tags : null,
    own: (typeof n.id === "string" && made.has(n.id)) || (typeof n.path === "string" && made.has(n.path)) });
  /** Asked again when the shell answers: a grant that ended while a call was in flight gets nothing back from it. */
  const after = <T,>(value: T): T => { check(); return value; };

  return {
    grant,
    /** Stop for good (revoked, or its screen is gone): every later call is refused. */
    close() { closed = true; },
    /** Ask before using something the shell lends (the microphone). */
    need(kind: "voice"): void {
      check();
      if (!allowsReach(grant, kind)) refuse("not_granted", "record your voice");
    },
    /** One op of a door. */
    async door<T = unknown>(door: string, op: string, args?: Record<string, unknown>): Promise<T> {
      check();
      if (!grant.doors.some((d) => d.door === door)) refuse("not_granted", `use the ${door} door`);
      const def = doorOp(door, op);
      if (!def || !allowsDoor(grant, door, op)) refuse("out_of_scope", `ask the ${door} door to ${op}`);
      return after(await be.command(def!.cmd, args)) as T;
    },
    vault: {
      /** Notes of a type and/or under a folder the grant lets it read; anything else that came back is dropped. */
      async query(vault: string, q: { type?: string; pathPrefix?: string; limit?: number; offset?: number }): Promise<PortNote[]> {
        check();
        const name = vaultOf(vault, "read notes");
        if (!allowsQuery(grant, name, q)) refuse("out_of_scope", `list ${q.type ?? "notes"}${q.pathPrefix ? ` in ${q.pathPrefix}` : ""} in the ${name} vault`);
        const limit = Math.min(200, Math.max(1, Math.floor(q.limit ?? 50))), offset = Math.max(0, Math.floor(q.offset ?? 0));
        const rows = await be.query(name, { ...(q.type ? { type: q.type } : {}), ...(q.pathPrefix ? { pathPrefix: q.pathPrefix } : {}), limit, offset });
        return after(rows).filter((n) => allowsNote(grant, name, "read", facts(n)));
      },
      /** One note, or null when it is absent or outside the grant (the two look the same). */
      async note(vault: string, ref: string): Promise<PortNote | null> {
        check();
        const name = vaultOf(vault, "read notes");
        const n = after(await be.note(name, ref).catch(() => null));
        return n && allowsNote(grant, name, "read", facts(n)) ? n : null;
      },
      /** Add a note. Every path it could land on must be inside a create rule. */
      async create<T = unknown>(vault: string, note: NewNote, audio?: { bytes: Uint8Array; mime: string }, o?: { saveAnother?: boolean }): Promise<T> {
        check();
        const name = vaultOf(vault, "add notes");
        // judged and written from one copy, read once: what is checked is what the writer gets
        let copy: NewNote;
        try { copy = JSON.parse(JSON.stringify(note)) as NewNote; } catch { copy = { path: "" }; }
        if (!copy || typeof copy !== "object" || Array.isArray(copy)) copy = { path: "" };
        const alternates = Array.isArray(copy.alternates) ? copy.alternates : [];
        copy.alternates = alternates;
        const paths = [copy.path, ...alternates];
        const tags = Array.isArray(copy.tags) ? copy.tags : null;
        if (!paths.every((p) => typeof p === "string" && allowsNote(grant, name, "create" satisfies Verb, { path: p, tags }))) refuse("out_of_scope", `add a note at ${String(copy.path).slice(0, 80)} in the ${name} vault`);
        const out = await be.create(name, copy, audio, o);
        // `own` covers only what the writer says this call made. The path asked for is never taken on trust: the writer may
        // have landed on another name, or added nothing, and the asked-for path may be someone else's note.
        for (const ref of out.made) if (typeof ref === "string" && ref) made.add(ref);
        return after(out.result) as T;
      },
      /** Would a note at this path be added right now? Throws as `create` would, without writing: ask before work that ends in a save. */
      async writable(vault: string, path: string): Promise<void> {
        check();
        const name = vaultOf(vault, "add notes");
        if (!allowsNote(grant, name, "create", { path, tags: null })) refuse("out_of_scope", `add a note at ${String(path).slice(0, 80)} in the ${name} vault`);
        await be.writable(name);
        check();
      },
    },
    /** Show the owner a note. Only one in a folder the grant lets it read (a folder rule: the shell judges the path alone). */
    open(vault: string, path: string): void {
      check();
      const name = vaultOf(vault, "open notes");
      if (!grant.vaults.some((v) => v.vault === name && v.allow.some((r) => r.type === undefined && r.verbs.includes("read") && !r.own && allowsNote({ ...grant, vaults: [{ vault: name, allow: [r] }] }, name, "read", { path })))) refuse("out_of_scope", `open ${path.slice(0, 80)} in the ${name} vault`);
      be.open(name, path);
    },
  };
}
export type AppletPort = ReturnType<typeof createAppletPort>;
