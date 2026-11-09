// T-335 one home: what needs Aaron is the task's `needs_aaron`, written by uni-tasks (needs.py, the one rule: an open ask owned by him, on a
// card, asked or confirmed by its room in 7 days, in a live place with a live room). The app never decides it. These older specs build tasks
// that stand for fresh asks on cards, so `swept` stamps the field the way that sweep would for them: a task (never an old `Decisions/` note)
// in a live state, owned by or waiting on him, not someday, not superseded. A spec that means otherwise sets needs_aaron itself.
export function swept(m: Record<string, unknown>, tags: readonly string[] = ["task"]): Record<string, unknown> {
  if ("needs_aaron" in m) return m;
  const his = [m.owner, m.waiting_on].some((v) => /^(person:|@)?aaron$/i.test(String(v ?? "").trim()));
  const live = ["open", "doing", "waiting"].includes(String(m.state ?? ""));
  const needs = tags.includes("task") && live && his && String(m.priority ?? "").toLowerCase() !== "someday" && !m.superseded_by && !m.answered_at;
  return { ...m, needs_aaron: needs };
}
