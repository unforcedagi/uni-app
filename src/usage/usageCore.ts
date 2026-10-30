// T-295 Claude accounts: the usage note, as the Settings card shows it. The launcher on the host keeps one vault note
// current (`System/Claude accounts`): each account's latest 5-hour session and weekly use with their reset times, the
// account new workers go to, and `account_preference` (auto, or an account name), which the card sets. Pure: no IPC.

export const USAGE_VAULT = "uni";
export const USAGE_NOTE = "System/Claude accounts";
export const USAGE_TAG = "claude-accounts";
const WEEK_H = 168;
/** A reading older than this is not shown as current (T-319: it says so plainly instead): the meter reads every 15 min, and the note
 *  follows within 15 more. */
export const STALE_MIN = 60;

export type UsageWindow = { used: number | null; resets_at: string | null };
export type UsageAccount = { name: string; signed_in?: boolean; read_at?: string | null; session?: UsageWindow | null; week?: UsageWindow | null };
export type UsageDoc = { version: number; read_at: string | null; stop: number | null; accounts: UsageAccount[]; preference: string;
  next: { account: string; how: string; why?: string | null } };

/** T-335: `paused` at or over the launcher's pacing stop but under 100 (it keeps the rest as headroom for rooms; `headroom` says so),
 *  `full` only at a real 100. */
export type Meter = { pct: number | null; text: string; reset: string | null; paused: boolean; full: boolean; headroom: string | null };
/** A row's `stale`: its own reading is over STALE_MIN old, or it has none (Codex zwmejvyc P2: each account's reading is its own; one
 *  fresh account doesn't make another's old numbers current). */
export type Row = { name: string; label: string; session: Meter; week: Meter & { pace: "on pace" | "ahead of pace" | null }; missing: boolean;
  readAt: string | null; stale: boolean;
  /** signed out: it is never read again, so its last numbers are neither current nor stale, only old (and not counted either way) */ out: boolean };
/** `stale`: no account has a fresh reading. `readAt`: the oldest fresh reading (what "as of" means for every number shown); when none is
 *  fresh, the newest there is. */
export type View = { rows: Row[]; choices: string[]; preference: string; next: { label: string; how: string } | null; readAt: string | null; stale: boolean;
  /** some account's reading is old (or missing) while another's is fresh */ someStale: boolean };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const NAME = /^[a-z][a-z0-9]{0,15}$/;

/** The note's `claude_accounts` metadata, checked; null when the note isn't one (another install, an older writer). */
export function parseDoc(metadata: unknown): UsageDoc | null {
  const d = (metadata as Record<string, unknown> | null)?.claude_accounts as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object" || !Array.isArray(d.accounts)) return null;
  const win = (w: unknown): UsageWindow | null => {
    if (!w || typeof w !== "object") return null;
    const o = w as Record<string, unknown>;
    return { used: num(o.used), resets_at: str(o.resets_at) };
  };
  const accounts = d.accounts.flatMap((a): UsageAccount[] => {
    const o = a as Record<string, unknown>;
    return o && typeof o.name === "string" && NAME.test(o.name)
      ? [{ name: o.name, signed_in: o.signed_in !== false, read_at: str(o.read_at), session: win(o.session), week: win(o.week) }] : [];
  });
  if (!accounts.length) return null;
  const nx = (d.next ?? {}) as Record<string, unknown>;
  return { version: num(d.version) ?? 1, read_at: str(d.read_at), stop: num(d.stop), accounts, preference: str(d.preference) ?? "auto",
    next: { account: str(nx.account) ?? "", how: str(nx.how) ?? "", why: str(nx.why) } };
}

/** The preference the card shows: the note's `account_preference` when it is auto or one of the accounts. */
export function preferenceOf(metadata: unknown, doc: UsageDoc): string {
  const p = (metadata as Record<string, unknown> | null)?.account_preference;
  return typeof p === "string" && (p === "auto" || doc.accounts.some((a) => a.name === p)) ? p : "auto";
}

export const accountLabel = (name: string) => `Account ${name.toUpperCase()}`;

function parts(d: Date, tz?: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, hour: p.hour, minute: p.minute, ampm: (p.dayPeriod ?? "").toLowerCase() };
}

/** "3:20pm" today, "Fri 7am" later in the week, in the device's zone (or `tz`). */
export function resetText(iso: string | null, now: Date, tz?: string): string | null {
  if (!iso) return null;
  const raw = new Date(iso).getTime();
  if (Number.isNaN(raw)) return null;
  const t = new Date(Math.round(raw / 60_000) * 60_000); // the meter says 06:59:59.6 for a 7:00 reset
  const p = parts(t, tz), n = parts(now, tz);
  const clock = `${p.hour}${p.minute === "00" ? "" : `:${p.minute}`}${p.ampm}`;
  if (p.day === n.day) return clock;
  if (t.getTime() - now.getTime() < 36 * 3600_000 && parts(new Date(now.getTime() + 86400_000), tz).day === p.day) return `tomorrow ${clock}`;
  return `${p.weekday} ${clock}`;
}

/** Weekly pace, the usage guard's maths: even use would be at 100 × (elapsed / 168 h) now; over that by 5 points is ahead. */
export function pace(used: number | null, resetsAt: string | null, now: Date): "on pace" | "ahead of pace" | null {
  if (used === null || !resetsAt) return null;
  const t = new Date(resetsAt).getTime();
  if (Number.isNaN(t)) return null;
  const hoursLeft = Math.max(0, (t - now.getTime()) / 3600_000);
  const even = Math.max(0, Math.min(100, 100 * (1 - hoursLeft / WEEK_H)));
  return used > even + 5 ? "ahead of pace" : "on pace";
}

// under 100 never reads "100%": 99.6 is 99% until it is really full
const pctText = (v: number | null) => (v === null ? "–" : `${v < 100 ? Math.min(99, Math.round(v)) : Math.round(v)}%`);

/** A meter's state against the stop: paused from the stop up to 100, full at 100. */
function level(used: number | null, stop: number) {
  const full = used !== null && used >= 100, paused = used !== null && !full && used >= stop;
  return { paused, full, headroom: paused ? `keeping ${Math.round(100 - stop)}% headroom for rooms` : null };
}

/** What the card shows, from the note's metadata at `now`. Null: no usage note to show. */
export function usageView(metadata: unknown, now: Date, tz?: string): View | null {
  const doc = parseDoc(metadata);
  if (!doc) return null;
  const stop = doc.stop ?? 100;
  const rows = doc.accounts.map((a): Row => {
    const s = a.session, w = a.week;
    // a window whose reset has passed is empty until the next reading
    const passed = (x: UsageWindow | null | undefined) => !!x?.resets_at && new Date(x.resets_at).getTime() <= now.getTime();
    const sUsed = s ? (passed(s) ? 0 : s.used) : null;
    const wUsed = w ? (passed(w) ? 0 : w.used) : null;
    const age = a.read_at ? (now.getTime() - new Date(a.read_at).getTime()) / 60_000 : NaN;
    const out = a.signed_in === false;
    return {
      name: a.name, label: accountLabel(a.name), missing: !a.read_at, readAt: a.read_at ?? null, stale: !out && !(age <= STALE_MIN), out,
      session: { pct: sUsed, text: pctText(sUsed), reset: sUsed ? resetText(s?.resets_at ?? null, now, tz) : null, ...level(sUsed, stop) },
      week: { pct: wUsed, text: pctText(wUsed), reset: w && !passed(w) ? resetText(w.resets_at, now, tz) : null, ...level(wUsed, stop),
        pace: w && !passed(w) ? pace(wUsed, w.resets_at, now) : null },
    };
  });
  const preference = preferenceOf(metadata, doc);
  const t = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);
  const active = rows.filter((r) => !r.out), fresh = active.filter((r) => !r.stale), dated = active.filter((r) => Number.isFinite(t(r.readAt)));
  const readAt = fresh.length ? fresh.reduce((a, r) => (t(r.readAt) < t(a.readAt) ? r : a)).readAt
    : dated.length ? dated.reduce((a, r) => (t(r.readAt) > t(a.readAt) ? r : a)).readAt : null;
  // the note's next account was decided with the note's preference: shown only while that is still the one set
  const next = doc.next.account && doc.preference === preference ? { label: accountLabel(doc.next.account), how: doc.next.how } : null;
  return { rows, choices: ["auto", ...doc.accounts.filter((a) => a.signed_in !== false).map((a) => a.name)], preference, next, readAt,
    stale: !fresh.length, someStale: !!fresh.length && fresh.length < active.length };
}

/** "12 min ago", "3 h ago": how old the reading is. */
export function ageText(iso: string | null, now: Date): string {
  if (!iso) return "no reading yet";
  const m = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  return m < 1 ? "just now" : m < 90 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

/** A paused account on the front door: "paused at 96%", the higher of its paused meters. */
const pausedText = (r: Row) => `paused at ${[r.session, r.week].filter((m) => m.paused).reduce((a, m) => ((m.pct ?? 0) > (a.pct ?? 0) ? m : a)).text}`;

/** The front door's line: "Claude: A 34% of the week · B 12% of the week · new work to B · as of 6 min ago" (a full account says so;
 *  T-335: one at the pacing stop says "paused at 95%").
 *  T-319: an old reading is never shown as current. With none fresh, the line says so instead of numbers; an account whose own reading is
 *  old says so in its place, and "as of" is the oldest of the numbers shown. */
export function usageLineText(v: View | null, now: Date): string | null {
  if (!v || !v.rows.length) return null;
  if (v.stale) return v.readAt ? `Claude: no fresh usage reading; the last one is from ${ageText(v.readAt, now)}` : "Claude: no usage reading yet";
  const parts = v.rows.map((r) => `${r.name.toUpperCase()} ${r.out ? "signed out" : r.missing ? "no reading" : r.stale ? `no fresh reading (${ageText(r.readAt, now).replace(/ ago$/, " old")})`
    : r.week.full || r.session.full ? "full" : r.week.paused || r.session.paused ? pausedText(r) : `${r.week.text} of the week`}`);
  return `Claude: ${parts.join(" · ")}${v.next ? ` · new work to ${v.next.label.replace(/^Account /, "")}` : ""} · as of ${ageText(v.readAt, now)}`;
}

export const howText = (how: string) => (how === "preference" ? "your choice" : how === "auto" ? "auto" : how === "default" ? "default" : how);
