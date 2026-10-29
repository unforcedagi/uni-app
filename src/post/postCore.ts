// T-335: the To post queue (pure, unit-tested in scripts/post.test.ts). A `post` note is one post Uni proposes for
// Aaron's account or its own; this module reads the notes into cards and says what each card may offer. Every write
// goes to Rust (uni-core post.rs), which re-reads the note, checks it again and signs; nothing here is trusted by the
// poster, which checks the signature itself.

export type Account = "aaron" | "uni";
export type PostState = "proposed" | "approved" | "posted" | "failed" | "dropped" | "taken-down";
export type PostCard = {
  id: string; path: string; updatedAt: string;
  account: Account; platform: string; provenance: string; piece: string; body: string; state: PostState;
  media: string[]; node: string | null; why: string | null;
  scheduledFor: string | null; approvedAt: string | null; postedUrl: string | null; postedAt: string | null;
  failedReason: string | null; feedback: string | null;
};

type RawNote = { id?: unknown; path?: unknown; updatedAt?: unknown; tags?: unknown; content?: unknown; metadata?: unknown };

const STATES: PostState[] = ["proposed", "approved", "posted", "failed", "dropped", "taken-down"];
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const opt = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export const PLATFORM_LABEL: Record<string, string> = { bluesky: "Bluesky", x: "X", "atproto-site": "Essay record" };
/** Code points, as the poster counts (Bluesky counts graphemes, never more than this). */
export const LIMIT: Record<string, number> = { bluesky: 300, x: 280, "atproto-site": 100_000 };

export function parsePost(n: RawNote): PostCard | null {
  const tags = Array.isArray(n.tags) ? n.tags : [];
  if (typeof n.id !== "string" || !tags.includes("post")) return null;
  const m = (n.metadata && typeof n.metadata === "object" ? n.metadata : {}) as Record<string, unknown>;
  const account = s(m.account), state = s(m.state) as PostState;
  if ((account !== "aaron" && account !== "uni") || !STATES.includes(state)) return null;
  return {
    id: n.id, path: s(n.path), updatedAt: s(n.updatedAt), account, platform: s(m.platform), provenance: s(m.provenance),
    piece: s(m.piece), body: s(m.body), state, media: Array.isArray(m.media) ? m.media.filter((x): x is string => typeof x === "string") : [],
    node: opt(m.node), why: opt(m.why), scheduledFor: opt(m.scheduled_for), approvedAt: opt(m.approved_at),
    postedUrl: opt(m.posted_url), postedAt: opt(m.posted_at), failedReason: opt(m.failed_reason), feedback: opt(m.feedback),
  };
}

export function parsePosts(notes: RawNote[]): PostCard[] {
  return notes.map(parsePost).filter((p): p is PostCard => !!p);
}

/** Whose words these are, in a word (the badge never relies on colour). */
export function voice(p: PostCard): "Your voice" | "Uni's voice" {
  return p.account === "aaron" ? "Your voice" : "Uni's voice";
}

/** Where it goes, in words: "Bluesky · your account". */
export function where(p: PostCard): string {
  return `${PLATFORM_LABEL[p.platform] ?? p.platform} · ${p.account === "aaron" ? "your account" : "Uni's account"}`;
}

/** The voice rule, as the poster enforces it: Aaron's account carries only his words, Uni's only Uni's. */
export function voiceOk(p: PostCard): boolean {
  return p.account === "aaron" ? p.provenance === "aaron-typed" || p.provenance === "aaron-excerpt" : p.provenance === "uni";
}

/** Why a proposed post can't be approved as it stands, or null. The same checks run again in Rust and in the poster. */
export function blocked(p: PostCard): string | null {
  if (!voiceOk(p)) return p.account === "aaron" ? "Uni's words never go out under your name." : "Your words never go out under Uni's name.";
  if (!(p.platform in LIMIT)) return "This platform isn't one the poster knows.";
  if (!p.body.trim()) return "There's nothing to post.";
  const n = [...p.body].length;
  if (n > LIMIT[p.platform]) return `${n} characters; ${PLATFORM_LABEL[p.platform]} allows ${LIMIT[p.platform]}.`;
  if (p.media.length) return "Posts with pictures or video can't go out yet.";
  if (p.provenance === "aaron-excerpt" && !p.piece) return "An excerpt must link the piece it quotes.";
  return null;
}

export type Queue = { review: PostCard[]; waiting: PostCard[]; done: PostCard[] };

/** To review (proposed), waiting to go out (approved), and what happened lately (posted, failed, taken down; newest
 *  first, at most `keep`). Dropped posts leave the queue. `node`: only one area's posts. */
export function queue(posts: PostCard[], node: string | null = null, keep = 10): Queue {
  const mine = node ? posts.filter((p) => p.node === node || (p.node ?? "").startsWith(node + "/")) : posts;
  const asc = (k: (p: PostCard) => string) => (a: PostCard, b: PostCard) => k(a).localeCompare(k(b)) || a.id.localeCompare(b.id);
  return {
    // oldest proposal first: the queue is cleared in one sitting, in the order it filled
    review: mine.filter((p) => p.state === "proposed").sort(asc((p) => p.updatedAt)),
    // soonest out first
    waiting: mine.filter((p) => p.state === "approved").sort(asc((p) => p.scheduledFor ?? p.approvedAt ?? p.updatedAt)),
    // newest first
    done: mine.filter((p) => p.state === "posted" || p.state === "failed" || p.state === "taken-down")
      .sort(asc((p) => p.postedAt ?? p.updatedAt)).reverse().slice(0, keep),
  };
}

/** The count on the quiet line: posts waiting for Aaron's review. */
export function reviewCount(posts: PostCard[], node: string | null = null): number {
  return queue(posts, node).review.length;
}

/** "Goes out within a minute" or "Goes out Fri 31 Oct, 09:00". */
export function waitingLine(p: PostCard, now: Date = new Date()): string {
  if (p.scheduledFor) {
    const t = new Date(p.scheduledFor);
    if (!Number.isNaN(t.getTime()) && t.getTime() > now.getTime() + 60_000) {
      return `Goes out ${t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    }
  }
  return "Approved · goes out within a minute";
}

/** A local `datetime-local` value as unix seconds, or null when it is empty, unreadable or not in the future. */
export function scheduleAt(value: string, now: Date = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t) || t <= now.getTime() + 60_000) return null;
  return Math.floor(t / 1000);
}

/** What Edit means for this card: Aaron's own words, or a note to Uni (his wording never goes out under Uni's name). */
export function editMode(p: PostCard): "words" | "note" {
  return p.account === "aaron" ? "words" : "note";
}
