// T-229 Calendar: the place next to Mail. Day, week (three days on a phone) and agenda over the instances the calendar
// door expands; create, edit, move (a form, or a drag on desktop), cancel and delete as the door's named ops, each with
// a fresh op id and the revision it saw; a repeating event asks "this / following / all". The detail shows who can see
// the event (private, shared with named people, public), its people, and "Send invites" behind a confirm. Conflict
// records the sync adapters leave are listed. Offline it shows the last snapshot, read-only. Only the ops the door's
// session offers this key are shown. Layout and marks are lifted from the T-229 prototype: shape and word before
// colour, so it reads on the Daylight, where nothing moves.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { addDays, dayKey, dayLabel, dayStart, HOUR, layoutDay, MIN, rangeLabel, ruleLabel, timeLabel, wall, zoned, type EventNote, type Instance, type Scope, type Visibility } from "./calCore.ts";
import { allDayMoved, inviteWords, asCalErr, attendeesText, can, daysBetween, daysFor, DEFAULT_TZ, formTimes, fromSnapshot, sameTime, inviteeLine, invitees, invitesWaiting, newOpId, parseAttendees, partstatWords, problemText, stepFor, toShown, who, windowFor, type CalErr, type Session, type Shown, type View } from "./calView.ts";
import { conflicts as readConflicts, doorAnswered, event as readEvent, events as readEvents, op as sendOp, readSnapshot, saveRead, session as readSession, type Conflict } from "./calDoor.ts";
import "./Calendar.css";

const HOUR_PX = 48;
const DAY_MS = 24 * HOUR;
/** The Daylight's WebView says Android: nothing of the Calendar's moves there. */
const still = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
/** Leaving and coming back keeps the view and the day. */
const remembered: { view: View | null; focus: string | null } = { view: null, focus: null };

function useMedia(q: string): boolean {
  const sub = useCallback((f: () => void) => { const m = matchMedia(q); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, [q]);
  return useSyncExternalStore(sub, () => matchMedia(q).matches, () => false);
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

type Sheet = { kind: "new"; day: string; time: string } | { kind: "edit"; inst: Shown; note: EventNote };
type Ask = { verb: "Move" | "Change" | "Cancel"; inst: Shown; thisOk: boolean; run: (scope: Scope) => void };

/** Word marks, never colour alone (e-ink). */
function Marks({ i, short }: { i: Pick<Shown, "status" | "show_as" | "visibility">; short?: boolean }) {
  return <>
    {i.status === "tentative" && <span className="cal-tag tag-tentative">{short ? "?" : "TENTATIVE"}</span>}
    {i.status === "cancelled" && <span className="cal-tag tag-cancelled">{short ? "✕" : "CANCELLED"}</span>}
    {i.show_as === "free" && !short && <span className="cal-tag tag-free">FREE</span>}
    {i.visibility === "public" && !short && <span className="cal-tag tag-public">PUBLIC</span>}
    {i.visibility === "shared" && !short && <span className="cal-tag tag-shared">SHARED</span>}
  </>;
}

const asInst = (i: Shown): Pick<Instance, "start" | "end" | "allDay"> => ({ start: i.s, end: i.e, allDay: i.all_day });
const statusWords = (i: Shown) => [i.status !== "confirmed" ? i.status : "", i.series ? "repeats" : "", i.visibility !== "private" ? i.visibility : ""].filter(Boolean).join(", ");
const evLabel = (i: Shown, tz: string) => `${i.title}, ${rangeLabel(asInst(i), tz)}${statusWords(i) ? `, ${statusWords(i)}` : ""}`;
const evClass = (i: Shown) => `cal-ev st-${i.status} show-${i.show_as} vis-${i.visibility}`;

// ── the time grid (day and week) ──────────────────────────────────────────────────────────────────────────────────

/** `from`: the column grabbed (an event past midnight has a piece in each day); `dayIdx`: the column under the pointer. */
type Drag = { key: string; from: number; dayIdx: number; deltaMin: number; moved: boolean };

function TimeGrid({ list, days, tz, today, now, canDrag, canNew, onOpen, onNew, onDrop }: { list: Shown[]; days: string[]; tz: string; today: string; now: number; canDrag: boolean; canNew: boolean;
  onOpen: (i: Shown) => void; onNew: (day: string, hhmm: string) => void; onDrop: (i: Shown, start: number) => void }) {
  const from = dayStart(days[0], tz);
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<{ inst: Shown; x: number; y: number; d: Drag } | null>(null);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX - 8; }, []);
  const fromLocal = (day: string, h: number, mi: number) => { const [y, m, d] = day.split("-").map(Number); return zoned(y, m, d, h, mi, tz); };

  const allDay = list.filter((i) => i.all_day || i.e - i.s >= DAY_MS);
  const timed = list.filter((i) => !allDay.includes(i));
  // a timed event shows on each day it covers (one that runs past midnight continues in the next column)
  const perDay = days.map((d) => { const ds = dayStart(d, tz), de = dayStart(addDays(d, 1), tz); return layoutDay(timed.filter((i) => i.s < de && i.e > ds).map((i) => ({ start: Math.max(i.s, ds), end: Math.min(i.e, de), i }))); });

  // a drag is for a mouse or a pen on a desktop; a touch opens the event, and its panel's Move moves it
  const down = (e: React.PointerEvent, inst: Shown, from: number) => {
    if (e.button !== 0 || !canDrag || e.pointerType === "touch" || inst.status === "cancelled") return;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* a pointer the browser doesn't track */ }
    dragRef.current = { inst, x: e.clientX, y: e.clientY, d: { key: inst.key, from, dayIdx: from, deltaMin: 0, moved: false } };
  };
  const move = (e: React.PointerEvent) => {
    const r = dragRef.current;
    if (!r || !cols.current) return;
    const dy = e.clientY - r.y, dx = e.clientX - r.x;
    if (!r.d.moved && Math.hypot(dx, dy) < 6) return;
    const box = cols.current.getBoundingClientRect();
    const dayIdx = Math.max(0, Math.min(days.length - 1, Math.floor((e.clientX - box.left) / (box.width / days.length))));
    r.d = { key: r.inst.key, from: r.d.from, dayIdx, deltaMin: Math.round(dy / (HOUR_PX / 4)) * 15, moved: true };
    setDrag(r.d);
  };
  const up = (inst: Shown) => {
    const r = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!r || !r.d.moved) return onOpen(inst);
    // the event's own start, as many days on as the pointer moved columns, at the same wall time
    const w = wall(r.inst.s, tz);
    const start = fromLocal(addDays(dayKey(r.inst.s, tz), r.d.dayIdx - r.d.from), w.h, w.mi) + r.d.deltaMin * MIN;
    if (start !== r.inst.s) onDrop(r.inst, start);
  };

  return <div className="cal-grid" style={{ ["--days" as string]: days.length }}>
    <div className="cal-grid-head">
      <div className="cal-gutter" />
      {days.map((d) => <div key={d} className={`cal-col-head ${d === today ? "today" : ""}`}><span>{dayLabel(d, "short").split(", ")[0]}</span> <strong>{Number(d.slice(8))}</strong></div>)}
    </div>
    {allDay.length > 0 && <div className="cal-allday" role="group" aria-label="All-day events">
      <div className="cal-gutter"><small>all day</small></div>
      <div className="cal-allday-cols">
        {allDay.map((i) => {
          const a = Math.max(0, days.indexOf(dayKey(Math.max(i.s, from), tz)));
          const last = days.indexOf(dayKey(i.e - 1, tz));
          const b = last < 0 ? days.length - 1 : last;
          return <button key={i.key} className={`${evClass(i)} cal-allday-ev`} style={{ gridColumn: `${a + 1} / ${b + 2}` }} aria-label={evLabel(i, tz)} onClick={() => onOpen(i)}>
            <span className="cal-ev-title">{i.title}</span><Marks i={i} short />
          </button>;
        })}
      </div>
    </div>}
    <div className="cal-scroll" ref={scroller}>
      <div className="cal-hours">
        <div className="cal-gutter">{Array.from({ length: 24 }, (_, h) => <div key={h} className="cal-hour-label" style={{ top: h * HOUR_PX }}>{h === 0 ? "" : timeLabel(fromLocal(days[0], h, 0), tz)}</div>)}</div>
        <div className="cal-cols" ref={cols}>
          {days.map((d, di) => <div key={d} className={`cal-col ${d === today ? "today" : ""}`} role="group" aria-label={dayLabel(d)}>
            {canNew && Array.from({ length: 48 }, (_, s) => <button key={s} className="cal-slot" style={{ top: s * (HOUR_PX / 2), height: HOUR_PX / 2 }} tabIndex={-1}
              aria-label={`New event ${dayLabel(d)} ${timeLabel(fromLocal(d, Math.floor(s / 2), s % 2 ? 30 : 0), tz)}`}
              onClick={() => onNew(d, `${pad(Math.floor(s / 2))}:${s % 2 ? "30" : "00"}`)} />)}
            {d === today && <div className="cal-now" style={{ top: ((now - dayStart(d, tz)) / HOUR) * HOUR_PX }} aria-label={`Now, ${timeLabel(now, tz)}`} role="img" />}
            {perDay[di].map(({ inst: { i: inst, start: segS, end: segE }, col, cols: n }) => {
              const dragging = drag?.key === inst.key && drag.moved ? drag : null;
              const top = ((segS - dayStart(d, tz)) / HOUR) * HOUR_PX + (dragging ? (dragging.deltaMin / 60) * HOUR_PX : 0);
              const h = Math.max(20, ((segE - segS) / HOUR) * HOUR_PX - 2);
              const shift = dragging ? dragging.dayIdx - dragging.from : 0;
              const narrow = days.length > 1 && days.length < 7;
              const short = h < 40 || narrow || n > 1;
              return <button key={inst.key} className={`${evClass(inst)} cal-timed ${h < 40 ? "short" : ""} ${n > 1 || narrow ? "tight" : ""} ${dragging ? "dragging" : ""}`} data-key={inst.key}
                style={{ top, height: h, left: `calc(${(col / n) * 100}% + ${shift * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)` }}
                aria-label={evLabel(inst, tz)} onPointerDown={(e) => down(e, inst, di)} onPointerMove={move} onPointerUp={() => up(inst)} onPointerCancel={() => { dragRef.current = null; setDrag(null); }}
                onClick={(e) => { if (e.detail === 0) onOpen(inst); }}>
                <span className="cal-ev-time">{timeLabel(dragging ? inst.s + dragging.deltaMin * MIN : inst.s, tz)}</span>
                <span className="cal-ev-title">{inst.title}</span>
                {!short && inst.location && <span className="cal-ev-where">{inst.location}</span>}
                <span className="cal-ev-marks"><Marks i={inst} short={short} /></span>
              </button>;
            })}
          </div>)}
        </div>
      </div>
    </div>
  </div>;
}

// ── agenda ────────────────────────────────────────────────────────────────────────────────────────────────────────

function Agenda({ list, days, tz, today, onOpen }: { list: Shown[]; days: string[]; tz: string; today: string; onOpen: (i: Shown) => void }) {
  const shown = days.map((d) => { const s = dayStart(d, tz), e = dayStart(addDays(d, 1), tz); return [d, list.filter((i) => i.s < e && i.e > s)] as const; }).filter(([, items]) => items.length);
  return <div className="cal-agenda cal-scroll-y">
    {shown.length === 0 && <p className="cal-empty">Nothing in these three weeks.</p>}
    {shown.map(([d, items]) => <section key={d} className={`cal-agenda-day ${d === today ? "today" : ""}`} aria-label={dayLabel(d)}>
      <h3>{dayLabel(d)}{d === today && <span className="cal-today-word"> · today</span>}</h3>
      <ul>{items.map((i) => <li key={i.key}><button className={`${evClass(i)} cal-agenda-ev`} aria-label={evLabel(i, tz)} onClick={() => onOpen(i)}>
        <span className="cal-agenda-time">{i.all_day ? "all day" : `${timeLabel(i.s, tz)} – ${timeLabel(i.e, tz)}`}</span>
        <span className="cal-agenda-what"><span className="cal-ev-title">{i.title}</span> <Marks i={i} />
          {(i.location || (i.attendees?.length ?? 0) > 0) && <small>{[i.location, (i.attendees ?? []).map(who).join(", ")].filter(Boolean).join(" · ")}</small>}</span>
        {i.series && <span className="cal-repeat" title="Repeats">↻</span>}
      </button></li>)}</ul>
    </section>)}
  </div>;
}

// ── detail ────────────────────────────────────────────────────────────────────────────────────────────────────────

function Field({ k, children }: { k: string; children: ReactNode }) {
  return <div className="cal-field"><dt>{k}</dt><dd>{children}</dd></div>;
}

const VIS: [Visibility, string, string][] = [
  ["private", "Private", "Only you."],
  ["shared", "Shared with…", "The people you name, in their share feed."],
  ["public", "Public", "Anyone: it can appear on your public calendar page."],
];

function Detail({ inst, note, sess, offline, tz, error, onClose, onEdit, onMove, onCancel, onDelete, onVisibility, onSendInvites }: {
  inst: Shown; note: EventNote | null; sess: Session | null; offline: boolean; tz: string; error: string | null;
  onClose: () => void; onEdit: () => void; onMove: (start: number, end: number, scope?: Scope) => void; onCancel: () => void; onDelete: () => void;
  onVisibility: (v: Visibility, sharedWith: string[]) => void; onSendInvites: () => void;
}) {
  const writable = !offline;
  const [moving, setMoving] = useState(false);
  const [day, setDay] = useState(dayKey(inst.s, tz));
  const [time, setTime] = useState(() => { const w = wall(inst.s, tz); return `${pad(w.h)}:${pad(w.mi)}`; });
  const [scope, setScope] = useState<Scope>("this");
  const [vis, setVis] = useState<Visibility>(note?.visibility ?? inst.visibility);
  const [shareText, setShareText] = useState((note?.shared_with ?? []).join(", "));
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { setVis(note?.visibility ?? inst.visibility); setShareText((note?.shared_with ?? []).join(", ")); }, [note, inst.visibility]);
  const sharedList = shareText.split(",").map((x) => x.trim()).filter(Boolean);
  const visChanged = vis !== (note?.visibility ?? inst.visibility) || (vis === "shared" && sharedList.join(",") !== (note?.shared_with ?? []).join(","));
  const people = note?.attendees ?? inst.attendees ?? [];
  // the note read for this revision of the event (a door that doesn't say its revision: the latest read)
  const fresh = !!note && (note.rev === undefined || note.rev === inst.rev);
  const waiting = note && fresh ? invitesWaiting(note, sess) : false;
  const doMove = (e: React.FormEvent) => {
    e.preventDefault();
    const [y, m, d] = day.split("-").map(Number);
    const [h, mi] = time.split(":").map(Number);
    const start = inst.all_day ? dayStart(day, tz) : zoned(y, m, d, h, mi, tz);
    onMove(start, start + (inst.e - inst.s), inst.series ? scope : undefined);
    setMoving(false);
  };
  return <aside className="cal-detail" role="dialog" aria-label={`Event: ${inst.title}`}>
    <header><h2>{inst.title}</h2><button className="icon-button" aria-label="Close event" onClick={onClose}>×</button></header>
    <p className="cal-detail-when">{rangeLabel(asInst(inst), tz)}</p>
    <p className="cal-detail-marks"><Marks i={inst} />{inst.status === "confirmed" && <span className="cal-tag">CONFIRMED</span>}</p>
    {error && <p className="cal-error" role="alert">{error}</p>}
    {waiting ? <section className="cal-invites" aria-label="Invites">
      <p>{inviteWords(note!) ?? <><strong>Invites not sent.</strong> {invitees(note!).length === 1 ? "One person is" : `${invitees(note!).length} people are`} on this event; nothing goes to them until you send it.</>}</p>
      {writable && <button className="primary" onClick={onSendInvites}>Send invites…</button>}
    </section>
    : note && fresh && inviteWords(note) && <p className="cal-note" role="status">{inviteWords(note)}</p>}
    <dl>
      <Field k="Time zone">{inst.tz}{inst.all_day ? " (all day)" : ""}</Field>
      {note?.rrule && <Field k="Repeats">{(() => { try { return ruleLabel(note.rrule); } catch { return note.rrule; } })()}{inst.recurrence_id ? " · this is one of them" : ""}</Field>}
      {inst.location && <Field k="Where">{inst.location}</Field>}
      {people.length > 0 && <Field k="People"><ul className="cal-people-list">{people.map((a) => <li key={a.address}>{who(a)} <small>· {partstatWords(a.partstat)}</small></li>)}</ul></Field>}
      {note?.description && <Field k="Notes"><span className="cal-desc">{note.description}</span></Field>}
      {note?.path && <Field k="Note"><code>{note.path}</code></Field>}
    </dl>
    <fieldset className="cal-vis" disabled={!writable || !can(sess, "update")}>
      <legend>Who can see it</legend>
      {VIS.map(([v, label, help]) => <label key={v} className="cal-radio"><input type="radio" name={`vis-${inst.key}`} checked={vis === v} onChange={() => setVis(v)} /> <span><strong>{label}</strong> <small>{help}</small></span></label>)}
      {vis === "shared" && <label className="cal-share">Shared with <input value={shareText} onChange={(e) => setShareText(e.target.value)} placeholder="People/Name or name@example.com, comma-separated" /></label>}
      {visChanged && writable && <div className="cal-actions">
        <button className="primary" disabled={vis === "shared" && sharedList.length === 0} onClick={() => onVisibility(vis, vis === "shared" ? sharedList : [])}>Save who can see it</button>
        {inst.series && <small className="cal-note">For every event in the series.</small>}
      </div>}
    </fieldset>
    {!writable ? <p className="cal-note">Offline: read-only until the calendar door answers.</p>
    : moving ? <form className="cal-move" onSubmit={doMove} aria-label="Move event">
      <label>Day <input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
      {!inst.all_day && <label>Start <input type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} /></label>}
      {inst.series && <fieldset><legend>Which events?</legend>
        {([["this", "This event"], ["following", "This and following"], ["all", "All events"]] as const).map(([v, l]) => <label key={v} className="cal-radio"><input type="radio" name="scope" checked={scope === v} onChange={() => setScope(v)} /> {l}</label>)}
      </fieldset>}
      <div className="cal-actions"><button type="submit" className="primary">Move</button><button type="button" onClick={() => setMoving(false)}>Back</button></div>
    </form>
    : deleting && can(sess, "delete") ? <div className="cal-confirm" role="group" aria-label="Delete event?">
      <p>Delete “{inst.title}”{inst.series ? " and every event in its series" : ""}? The note leaves the vault. Cancelling keeps it.</p>
      <div className="cal-actions"><button className="danger" onClick={() => { setDeleting(false); onDelete(); }}>Delete</button><button onClick={() => setDeleting(false)}>Keep it</button></div>
    </div>
    : inst.status !== "cancelled" ? <div className="cal-actions">
      {can(sess, "update") && <button onClick={onEdit} disabled={!fresh}>Edit…</button>}
      {can(sess, "move") && <button onClick={() => setMoving(true)}>Move…</button>}
      {can(sess, "cancel") && <button onClick={onCancel}>{inst.series ? "Cancel…" : "Cancel event"}</button>}
      {can(sess, "delete") && <button className="quiet-danger" onClick={() => setDeleting(true)}>Delete…</button>}
    </div>
    : can(sess, "delete") && <div className="cal-actions"><button className="quiet-danger" onClick={() => setDeleting(true)}>Delete…</button></div>}
  </aside>;
}

// ── sheets: new and edit, which events, send invites ──────────────────────────────────────────────────────────────

function EventForm({ sheet, tz, blocked, onClose, onSave }: { sheet: Sheet; tz: string; blocked: boolean; onClose: () => void; onSave: (fields: Record<string, unknown>, changedKeys: string[]) => void }) {
  const editing = sheet.kind === "edit" ? sheet : null;
  const n = editing?.note;
  const series = !!editing?.inst.series;
  const hhmm = (ms: number) => { const w = wall(ms, tz); return `${pad(w.h)}:${pad(w.mi)}`; };
  const [title, setTitle] = useState(n?.title ?? "");
  const [day, setDay] = useState(editing ? dayKey(editing.inst.s, tz) : (sheet as { day: string }).day);
  const [allDay, setAllDay] = useState(editing ? editing.inst.all_day : false);
  const [start, setStart] = useState(() => editing ? hhmm(editing.inst.s) : (sheet as { time: string }).time);
  const [end, setEnd] = useState(() => { if (editing) return hhmm(editing.inst.e); const [h, m] = (sheet as { time: string }).time.split(":").map(Number); return `${pad((h + 1) % 24)}:${pad(m)}`; });
  // a timed event that ends on a later day keeps doing so; an all-day one keeps its last day
  const endOffset = editing && !editing.inst.all_day ? daysBetween(dayKey(editing.inst.s, tz), dayKey(editing.inst.e, tz)) : 0;
  const [lastDay, setLastDay] = useState(() => editing?.inst.all_day ? addDays(dayKey(editing.inst.e, tz), -1) : day);
  const [repeat, setRepeat] = useState("");
  const [where, setWhere] = useState(n?.location ?? "");
  const [notes, setNotes] = useState(n?.description ?? "");
  const [people, setPeople] = useState(attendeesText(n?.attendees));
  const [vis, setVis] = useState<Visibility>(n?.visibility ?? "private");
  const [err, setErr] = useState<string | null>(null);
  const [timeTouched, setTimeTouched] = useState(false);
  const touched = <T,>(set: (v: T) => void) => (v: T) => { setTimeTouched(true); set(v); };
  const times = formTimes({ day, allDay, start, end, endOffset, lastDay: lastDay < day ? day : lastDay }, tz);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    if (!title.trim()) return setErr("Give it a title.");
    const att = parseAttendees(people, n?.attendees ?? []);
    if ("bad" in att) return setErr(`“${att.bad}” isn't an email address.`);
    const fields: Record<string, unknown> = { title: title.trim(), location: where.trim(), description: notes.trim(), attendees: att };
    const t = series ? null : formTimes({ day, allDay, start, end, endOffset, lastDay }, tz);
    if (t && "error" in t) return setErr(t.error);
    if (!editing) {
      const wd = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7];
      const rrule = repeat === "weekly" ? `FREQ=WEEKLY;BYDAY=${wd}` : repeat === "weekdays" ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" : repeat === "daily" ? "FREQ=DAILY" : undefined;
      Object.assign(fields, { start: t!.start, end: t!.end, all_day: allDay, tz, visibility: vis });
      if (rrule) fields.rrule = rrule;
      if (!where.trim()) delete fields.location;
      if (!notes.trim()) delete fields.description;
      if (!att.length) delete fields.attendees;
      return onSave(fields, Object.keys(fields));
    }
    // an edit sends only what changed; a new time goes as start and end together (the door wants both), and the
    // event keeps its own zone
    const before: Record<string, unknown> = { title: n!.title, location: n!.location ?? "", description: n!.description ?? "", attendees: n!.attendees ?? [] };
    const changed = Object.keys(fields).filter((k) => JSON.stringify(fields[k]) !== JSON.stringify(before[k]));
    if (timeTouched && t && !("error" in t) && (allDay !== n!.all_day || !sameTime(t.start, n!.start) || !sameTime(t.end, n!.end))) {
      Object.assign(fields, { start: t.start, end: t.end, all_day: allDay });
      changed.push("start", "end", "all_day");
    }
    if (!changed.length) return onClose();
    onSave(Object.fromEntries(changed.map((k) => [k, fields[k]])), changed);
  };
  const invited = parseAttendees(people);
  return <div className="cal-sheet-scrim"><form className="cal-sheet" role="dialog" aria-label={editing ? "Edit event" : "New event"} onSubmit={save}>
    <h2>{editing ? "Edit event" : "New event"}</h2>
    <label>Title <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What" /></label>
    {series ? <p className="cal-note">It repeats. To change its time, use Move.</p> : <>
      <div className="cal-row">
        <label>{allDay ? "First day" : "Day"} <input type="date" value={day} onChange={(e) => { const was = daysBetween(day, lastDay); setTimeTouched(true); setDay(e.target.value); if (e.target.value) setLastDay(addDays(e.target.value, Math.max(0, was))); }} /></label>
        {allDay && <label>Last day <input type="date" value={lastDay} min={day} onChange={(e) => touched(setLastDay)(e.target.value)} /></label>}
        <label className="cal-check"><input type="checkbox" checked={allDay} onChange={(e) => touched(setAllDay)(e.target.checked)} /> All day</label>
      </div>
      {!allDay && <div className="cal-row">
        <label>Start <input type="time" step={900} value={start} onChange={(e) => touched(setStart)(e.target.value)} /></label>
        <label>End <input type="time" step={900} value={end} onChange={(e) => touched(setEnd)(e.target.value)} /></label>
      </div>}
      {!allDay && !("error" in times) && times.endDay !== day && <p className="cal-note">Ends {dayLabel(times.endDay)}.</p>}
    </>}
    {!editing && <label>Repeats <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
      <option value="">Doesn't repeat</option><option value="daily">Every day</option><option value="weekly">Every week on this day</option><option value="weekdays">Every weekday</option>
    </select></label>}
    <label>Where <input value={where} onChange={(e) => setWhere(e.target.value)} placeholder="Place or call" /></label>
    <label>People to invite <input value={people} onChange={(e) => setPeople(e.target.value)} placeholder="name@example.com, comma-separated" inputMode="email" /></label>
    {!("bad" in invited) && invited.length > 0 && <p className="cal-note">Invites wait until you send them from the event.</p>}
    {!editing && <label>Who can see it <select value={vis} onChange={(e) => setVis(e.target.value as Visibility)}>
      <option value="private">Private: only you</option><option value="shared">Shared: people you name (set them on the event)</option><option value="public">Public: anyone</option>
    </select></label>}
    <label>Notes <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} /></label>
    <p className="cal-note">Times in {tz}.</p>
    {err && <p className="cal-error" role="alert">{err}</p>}
    {blocked && <p className="cal-note" role="status">The calendar door isn't answering: this can be saved once it does.</p>}
    <div className="cal-actions"><button type="submit" className="primary" disabled={blocked}>{editing ? "Save" : "Add event"}</button><button type="button" onClick={onClose}>Cancel</button></div>
  </form></div>;
}

function ScopeAsk({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const verb = ask.verb;
  const go = (s: Scope) => { onClose(); ask.run(s); };
  return <div className="cal-sheet-scrim"><div className="cal-sheet small" role="dialog" aria-label={`${verb} a repeating event`}>
    <h2>{verb} “{ask.inst.title}”</h2>
    <p>It repeats. Which events?</p>
    {!ask.thisOk && <p className="cal-note">People and notes belong to the whole series, so this change can't be for one event alone.</p>}
    <div className="cal-actions col">
      {ask.thisOk && <button className="primary" onClick={() => go("this")}>This event</button>}
      <button className={ask.thisOk ? "" : "primary"} onClick={() => go("following")}>This and following</button>
      <button onClick={() => go("all")}>All events</button>
      <button onClick={onClose}>{verb === "Cancel" ? "Keep them" : `Don't ${verb.toLowerCase()}`}</button>
    </div>
  </div></div>;
}

function InviteConfirm({ note, onSend, onClose }: { note: EventNote; onSend: () => void; onClose: () => void }) {
  const to = invitees(note);
  return <div className="cal-sheet-scrim"><div className="cal-sheet small" role="dialog" aria-label="Send invites?">
    <h2>Send invites?</h2>
    <p>An invitation to “{note.title}” goes by email, from your address, to:</p>
    <ul className="cal-invitees">{to.map((a) => <li key={a.address}>{inviteeLine(a)}</li>)}</ul>
    <p className="cal-note">They can reply to accept or decline. A later change sends them an update.</p>
    <div className="cal-actions"><button className="primary" onClick={() => { onClose(); onSend(); }}>Send invites</button><button onClick={onClose}>Not now</button></div>
  </div></div>;
}

function Conflicts({ list, tz, onOpen, onClose }: { list: Conflict[]; tz: string; onOpen: (c: Conflict) => void; onClose: () => void }) {
  const span = (x: { start: string; end: string }) => rangeLabel({ start: Date.parse(x.start.length === 10 ? `${x.start}T12:00:00Z` : x.start), end: Date.parse(x.end.length === 10 ? `${x.end}T12:00:00Z` : x.end), allDay: x.start.length === 10 }, tz);
  const from = (a: string) => ({ google: "Google", stalwart: "Your phone or mail app (CalDAV)" } as Record<string, string>)[a] ?? a;
  return <section className="cal-conflicts" aria-label="Conflicts">
    <header><h2>Conflicts</h2><button className="icon-button" aria-label="Close conflicts" onClick={onClose}>×</button></header>
    <p className="cal-note">Two edits met. The calendar kept its own version and saved the other here.</p>
    <ul>{list.map((c) => <li key={c.id} className="cal-conflict">
      <p><strong>{c.title}</strong>{c.created && <small> · {dayLabel(dayKey(Date.parse(c.created), tz), "short")}</small>}</p>
      <div className="cal-conflict-sides">
        <div><span className="cal-tag">KEPT</span> {span(c.vault)}{c.vault.location ? ` · ${c.vault.location}` : ""}</div>
        <div><span className="cal-tag tag-free">{from(c.adapter).toUpperCase().split(" ")[0]}</span> {span(c.outside)}{c.outside.location ? ` · ${c.outside.location}` : ""} <small>({from(c.adapter)})</small></div>
      </div>
      <button className="cal-link" onClick={() => onOpen(c)}>Show the event ›</button>
    </li>)}</ul>
  </section>;
}

// ── the place ─────────────────────────────────────────────────────────────────────────────────────────────────────

export default function Calendar({ backTo, onBack }: { backTo: string; onBack: () => void }) {
  const phone = useMedia("(max-width: 599px)");
  const wide = useMedia("(min-width: 900px)");
  const beside = useMedia("(min-width: 1000px)");
  const [sess, setSess] = useState<Session | null>(() => readSnapshot()?.session ?? null);
  const tz = sess?.tz ?? DEFAULT_TZ;
  const now = Date.now();
  const today = dayKey(now, tz);
  const [view, setView] = useState<View>(remembered.view ?? (wide ? "week" : "agenda"));
  const [focus, setFocus] = useState(remembered.focus ?? today);
  useEffect(() => { remembered.view = view; remembered.focus = focus; }, [view, focus]);
  const days = useMemo(() => daysFor(view, focus, phone), [view, focus, phone]);
  const win = windowFor(days, tz);
  const [data, setData] = useState<{ from: string; to: string; list: Shown[]; complete: boolean } | null>(null);
  const [offline, setOffline] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [problem, setProblem] = useState<CalErr | null>(null);
  const [open, setOpen] = useState<Shown | null>(null);
  const openRef = useRef<Shown | null>(null);
  openRef.current = open;
  const [note, setNote] = useState<EventNote | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [inviting, setInviting] = useState<EventNote | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflictList, setConflictList] = useState<Conflict[]>([]);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const pendingOpen = useRef<string | null>(null);

  // the session is read from the door when the place opens and on Refresh; a snapshot's is only for showing it offline
  const sessLive = useRef(false);
  const load = useCallback(async (fresh = false): Promise<Shown[] | null> => {
    const n = ++seq.current;
    try {
      const s = sess && sessLive.current && !fresh ? sess : await readSession(win.from, win.to);
      sessLive.current = true;
      const r = await readEvents(win.from, win.to);
      if (n !== seq.current) return null;
      const list = toShown(r.instances ?? []);
      setSess(s); doorAnswered(); saveRead(win.from, win.to, r.instances ?? [], s);
      setData({ from: win.from, to: win.to, list, complete: r.complete !== false }); setOffline(false); setProblem(null);
      reconcile(list, false);
      readConflicts().then((c) => { if (n === seq.current) setConflictList(Array.isArray(c.conflicts) ? c.conflicts : []); }).catch(() => setConflictList([]));
      return list;
    } catch (e) {
      if (n !== seq.current) return null;
      const err = asCalErr(e);
      if (err.kind === "unreachable") {
        const snap = readSnapshot();
        const got = fromSnapshot(snap, win.from, win.to);
        setOffline(true); setSavedAt(snap?.at ?? null);
        if (!sess && snap?.session) setSess(snap.session);
        setData(got ? { from: win.from, to: win.to, list: toShown(got.instances), complete: got.complete } : null);
        if (got) reconcile(toShown(got.instances), true);
        setProblem(got ? null : err);
      } else {
        setProblem(err);
      }
      return null;
    }
  }, [win.from, win.to, sess]);
  useEffect(() => { void load(); }, [win.from, win.to]); // eslint-disable-line react-hooks/exhaustive-deps
  // offline, a pending question can't be answered: it closes (a form keeps what was typed, but can't save)
  useEffect(() => { if (offline) { setAsk(null); setInviting(null); } }, [offline]);

  // the open event's full note (description, who it's shared with, its people), read again after every write
  const noteSeq = useRef(0);
  const readNote = useCallback(async (i: Shown | null) => {
    const n = ++noteSeq.current;
    // the same event read again keeps what it showed until the new read lands; another event starts empty
    setNote((cur) => (i && cur?.id === i.id ? cur : null));
    if (!i || offline) return;
    try { const got = await readEvent(i.id); if (n === noteSeq.current) setNote(got); } catch (e) { if (n === noteSeq.current) setDetailErr(problemText(asCalErr(e))); }
  }, [offline]);
  const openEvent = (i: Shown | null) => { setOpen(i); setDetailErr(null); void readNote(i); };

  // after every read (Refresh, a write, another week), the open event is the instance as it is now (it may have
  // moved, or gone), and its note is read again
  function reconcile(list: Shown[], offlineNow: boolean) {
    const cur = openRef.current;
    if (!cur) return;
    const now = list.find((x) => x.key === cur.key) ?? list.find((x) => x.id === cur.id && x.recurrence_id === cur.recurrence_id) ?? null;
    setOpen(now);
    if (!offlineNow) void readNote(now);
  }
  useEffect(() => {
    if (!pendingOpen.current || !data) return;
    const hit = data.list.find((x) => x.id === pendingOpen.current);
    if (hit) { pendingOpen.current = null; openEvent(hit); }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const busyRef = useRef(false);
  const unanswered = useRef<{ body: string; opId: string } | null>(null);
  /**
   * One named op, then read again. A stale write changes nothing and shows the event as it is now. An op whose answer
   * never came back is sent again under the same op id, so the door applies it once.
   */
  const write = async (o: Record<string, unknown>, done: string, after?: (answer: { id?: string }) => void) => {
    if (busyRef.current) return;
    if (!writable) { setNotice("Nothing can change until the calendar door answers."); return; }
    if (!can(sess, String(o.op))) { setNotice("This device's key can't do that here."); return; }
    busyRef.current = true;
    setBusy(true); setDetailErr(null);
    const body = JSON.stringify(o);
    const opId = unanswered.current?.body === body ? unanswered.current.opId : newOpId();
    try {
      const r = await sendOp({ ...o, opId });
      unanswered.current = null;
      setNotice(done);
      after?.(r);
      await load();
    } catch (e) {
      const err = asCalErr(e);
      unanswered.current = err.kind === "unreachable" || err.kind === "server" ? { body, opId } : null;
      // whatever went wrong, the panel shows the event as the door has it now (a lost answer may have been applied)
      await load();
      if (open) setDetailErr(problemText(err)); else setNotice(problemText(err));
    } finally { busyRef.current = false; setBusy(false); }
  };

  const base = (i: Shown) => ({ id: i.id, base_rev: i.rev, ...(i.recurrence_id ? { recurrence_id: i.recurrence_id } : {}) });
  const whenWords = (start: number, allDay: boolean) => allDay ? dayLabel(dayKey(start, tz)) : `${dayLabel(dayKey(start, tz), "short")}, ${timeLabel(start, tz)}`;
  const moveTo = (i: Shown, start: number, end: number, scope?: Scope) => {
    const times = i.all_day ? allDayMoved(i.start, i.end, dayKey(start, tz)) : { start: iso(start), end: iso(end) };
    const run = (s: Scope) => void write({ op: "move", ...base(i), ...times, scope: s }, `Moved “${i.title}” to ${whenWords(start, i.all_day)}.`);
    if (i.series && !scope) setAsk({ verb: "Move", inst: i, thisOk: true, run });
    else run(scope ?? "all");
  };
  const cancel = (i: Shown) => {
    const run = (s: Scope) => void write({ op: "cancel", ...base(i), scope: s }, `Cancelled “${i.title}”.`);
    if (i.series) setAsk({ verb: "Cancel", inst: i, thisOk: true, run }); else run("all");
  };
  const saveForm = (fields: Record<string, unknown>, changed: string[]) => {
    const s = sheet!;
    setSheet(null);
    if (s.kind === "new") {
      void write({ op: "create", fields }, `Added “${fields.title}”.`, (r) => { if (r.id) pendingOpen.current = r.id; });
      const d = String(fields.start).length === 10 ? String(fields.start) : dayKey(Date.parse(String(fields.start)), tz);
      if (!days.includes(d)) setFocus(d);
      return;
    }
    const i = s.inst;
    const run = (sc: Scope) => void write({ op: "update", ...base(i), fields, scope: sc }, `Saved “${String(fields.title ?? i.title)}”.`);
    if (i.series) setAsk({ verb: "Change", inst: i, thisOk: changed.every((k) => ["title", "location"].includes(k)), run }); else run("all");
  };
  const setVisibility = (i: Shown, v: Visibility, shared: string[]) =>
    void write({ op: "update", id: i.id, base_rev: i.rev, fields: { visibility: v, shared_with: shared }, scope: "all" }, v === "private" ? "Now private: only you see it." : v === "public" ? "Now public." : `Shared with ${shared.length === 1 ? shared[0] : `${shared.length} people`}.`);
  // the confirm names the revision it showed: the door sends only to the people on it (CONTRACT-CHANGES, cal-app 6)
  const sendInvites = (n: EventNote) => void write({ op: "send_invites", id: n.id, base_rev: n.rev }, "Invites are on their way, from your address.");
  const deleteEvent = (i: Shown) => void write({ op: "delete", id: i.id, base_rev: i.rev }, `Deleted “${i.title}”.`, () => { setOpen(null); setNote(null); });

  useEffect(() => { if (!notice) return; const t = window.setTimeout(() => setNotice(null), 5000); return () => window.clearTimeout(t); }, [notice]);

  const md = (d: string) => dayLabel(d, "short").split(", ")[1];
  const label = view === "day" ? (phone ? dayLabel(focus, "short") : dayLabel(focus)) : view === "week" ? (phone ? `${md(days[0])} – ${md(days[days.length - 1])}` : `${dayLabel(days[0], "short")} – ${dayLabel(days[days.length - 1], "short")}`) : `From ${dayLabel(focus, "short")}`;
  const step = stepFor(view, phone);
  // what is on screen is this window's read; a failed read again leaves it shown, but nothing can change
  const shown = data && data.from === win.from && data.to === win.to ? data : null;
  const writable = !offline && !problem && !!sess && !!shown;
  const list = shown?.list ?? [];
  const savedWords = savedAt ? `${dayLabel(dayKey(Date.parse(savedAt), tz), "short")}, ${timeLabel(Date.parse(savedAt), tz)}` : null;

  return <section className={`cal ${still ? "cal-still" : ""}`} aria-label="Calendar" aria-busy={busy || undefined}>
    <header className="note-bar cal-bar">
      <button className="note-action" onClick={onBack}>← {backTo}</button>
      <span className="cal-title"><strong>Calendar</strong>{offline && <span className="cal-offline" role="status">OFFLINE{savedWords ? ` · saved ${savedWords}` : ""}</span>}{sess?.role === "uni" && <small> · as Uni</small>}</span>
      <button className="note-action" onClick={() => void load(true)}>{offline ? "Retry" : "Refresh"}</button>
    </header>
    <div className="cal-head">
      <div className="cal-nav">
        <button className="icon-button" aria-label="Earlier" onClick={() => setFocus(addDays(focus, -step))}>‹</button>
        <button onClick={() => setFocus(today)}>Today</button>
        <button className="icon-button" aria-label="Later" onClick={() => setFocus(addDays(focus, step))}>›</button>
        <h1 className="cal-range">{label}</h1>
      </div>
      <div className="cal-tabs" role="tablist" aria-label="Calendar view">
        {(["day", "week", "agenda"] as const).map((v) => <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}>{v === "week" && phone ? "3 days" : v[0].toUpperCase() + v.slice(1)}</button>)}
      </div>
      {conflictList.length > 0 && <button className="cal-conflicts-open" aria-expanded={conflictsOpen} onClick={() => setConflictsOpen(!conflictsOpen)}>Conflicts ({conflictList.length})</button>}
      {writable && can(sess, "create") && <button className="primary cal-new" onClick={() => setSheet({ kind: "new", day: days.includes(today) ? today : days[0], time: "10:00" })}>New event</button>}
    </div>
    {offline && <p className="cal-offline-note" role="note">The calendar door isn't answering. This is what this device last read{shown && !shown.complete ? " (not all of these days were saved)" : ""}; nothing can change until it answers.</p>}
    {conflictsOpen && conflictList.length > 0 && <Conflicts list={conflictList} tz={tz} onClose={() => setConflictsOpen(false)} onOpen={(c) => {
      setConflictsOpen(false);
      const hit = list.find((x) => x.id === c.event_id);
      if (hit) openEvent(hit); else { pendingOpen.current = c.event_id; setFocus(dayKey(Date.parse(c.vault.start.length === 10 ? `${c.vault.start}T12:00:00Z` : c.vault.start), tz)); }
    }} />}
    {problem && shown && <p className="cal-stale" role="alert">Couldn't read it again: {problemText(problem)} What's shown may be out of date; nothing can change. <button className="cal-link" onClick={() => void load(true)}>Retry</button></p>}
    {problem && !shown ? <div className="cal-problem" role="alert"><p>{problemText(problem)}</p><button onClick={() => void load(true)}>Retry</button></div>
    : !shown ? <p className="cal-loading" role="status">Loading the calendar…</p>
    : <div className={`cal-body ${open && beside ? "with-detail" : ""}`}>
      <div className="cal-main">
        {view === "agenda" ? <Agenda list={list} days={days} tz={tz} today={today} onOpen={openEvent} />
          : <TimeGrid key={`${view}:${days[0]}`} list={list} days={days} tz={tz} today={today} now={now} canDrag={writable && can(sess, "move") && !phone} canNew={writable && can(sess, "create")}
            onOpen={openEvent} onNew={(d, t) => setSheet({ kind: "new", day: d, time: t })} onDrop={(i, s) => moveTo(i, s, s + (i.e - i.s))} />}
      </div>
      {open && <Detail key={`${open.key}@${open.rev}`} inst={open} note={note} sess={sess} offline={!writable} tz={tz} error={detailErr} onClose={() => openEvent(null)}
        onEdit={() => note && setSheet({ kind: "edit", inst: open, note })} onMove={(s, e, sc) => moveTo(open, s, e, sc)} onCancel={() => cancel(open)} onDelete={() => deleteEvent(open)}
        onVisibility={(v, sh) => setVisibility(open, v, sh)} onSendInvites={() => note && setInviting(note)} />}
    </div>}
    <p className="cal-tz">Times in {tz}</p>
    {sheet && <EventForm sheet={sheet} tz={tz} blocked={!writable} onClose={() => setSheet(null)} onSave={saveForm} />}
    {ask && <ScopeAsk ask={ask} onClose={() => setAsk(null)} />}
    {inviting && can(sess, "send_invites") && note?.id === inviting.id && note.rev === inviting.rev && <InviteConfirm note={inviting} onClose={() => setInviting(null)} onSend={() => sendInvites(inviting)} />}
    {notice && <p className="cal-notice" role="status">{notice}</p>}
  </section>;
}
