/** T-335 one ask, step 2: the shared case file (src/ask/cases.json, the one uni-ask's TypeScript and Python suites run) run in the app's own suite, on the
 * vendored library (src/ask/README.md). Copied from uni-ask ts/test/cases.test.ts at ce45775 with only the two paths changed.
 * Steps become real signed events made by the library's own builders; checks run on the events as given and reversed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { AskError, askState, buildAnswer, buildAsk, buildClose, buildSealedAnswer, parseAsk, pubkeyHex, readAll,
  roomAsks, signEvent, type Ask, type NostrEvent, type Template } from "../src/ask/index.ts";

const CASES = JSON.parse(readFileSync(new URL("../src/ask/cases.json", import.meta.url), "utf8"));
const T0 = 1_800_000_000;
const UNIT: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
const AUX = new Uint8Array(32);
const TIME = /^@T((?:[+-]\d+[smhd]?)*)$/;
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const key = (name: string) => sha256(new TextEncoder().encode("uni-ask case key: " + name));
const PUB: Record<string, string> = Object.fromEntries(["uni", "aaron", "broker", "stranger"].map((n) => [n, pubkeyHex(key(n))]));

function at(expr: string): number {
  const m = TIME.exec(expr);
  assert.ok(m, expr);
  return T0 + [...m[1].matchAll(/([+-]\d+)([smhd]?)/g)].reduce((s, x) => s + Number(x[1]) * UNIT[x[2]], 0);
}

function resolve(obj: Any, ids: Record<string, string>): Any {
  if (typeof obj === "string") {
    if (TIME.test(obj)) return at(obj);
    return obj.replace(/\{\{deep:(\d+)\}\}/g, (_, n) => "[".repeat(Number(n)) + "]".repeat(Number(n)))
      .replace(/\{\{(\w+)\}\}/g, (_, n) => ids[n] ?? PUB[n]);
  }
  if (Array.isArray(obj)) return obj.map((x) => resolve(x, ids));
  if (obj && typeof obj === "object") return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolve(v, ids)]));
  return obj;
}

function theAsk(ev: NostrEvent): Ask {
  const [ask, why] = parseAsk(ev, [ev.pubkey]);
  assert.ok(ask, why);
  return ask;
}

type Held = NostrEvent & { _arrives?: number };
function buildEvents(steps: Any[]): [Held[], Record<string, string>] {
  const events: Held[] = [], ids: Record<string, string> = {}, byName: Record<string, NostrEvent> = {};
  for (const raw of steps) {
    const s = resolve(raw, ids);
    if (s.literal !== undefined) { // an event exactly as written, unsigned
      events.push({ ...s.literal, _arrives: s.arrives ?? s.literal.created_at });
      ids[s.id] = s.literal.id;
      continue;
    }
    const t: number = s.at;
    const ask = s.ask !== undefined && s.type !== "ask" ? theAsk(byName[s.ask]) : null;
    let tmpl: Template;
    if (s.type === "ask") tmpl = buildAsk(s.room, s.block, t);
    else if (s.type === "answer") {
      tmpl = buildAnswer(ask!, s.a, { pick: s.pick, later: s.later, now: t });
      if (s.room !== undefined) tmpl.tags = tmpl.tags.map((tg) => (tg[0] === "h" ? ["h", s.room] : tg));
    } else if (s.type === "reply") {
      const ref = s.ref ?? "q";
      if (ref === "q" && !["approve", "give"].includes(ask!.kind)) tmpl = buildAnswer(ask!, "words", { text: s.text });
      else if (ref === "q") tmpl = { kind: 9, tags: [["h", ask!.room], ["q", ask!.id, "", ask!.asker], ["p", ask!.asker]], content: s.text };
      else tmpl = { kind: 9, tags: [["h", ask!.room], ["e", ask!.id, "", "reply"], ["p", ask!.asker]], content: s.text };
    } else if (s.type === "close") tmpl = buildClose(ask!, s.why);
    else if (s.type === "edit") {
      tmpl = { kind: 40003, tags: [["h", ask!.room], ["e", ask!.id]], content: buildAsk(ask!.room, s.block, ask!.at).content };
    } else if (s.type === "delete") tmpl = { kind: 5, tags: [["h", ask!.room], ["e", ask!.id]], content: "" };
    else tmpl = { kind: s.kind, tags: s.tags, content: s.content };
    const ev: Held = signEvent(key(s.by), tmpl, t, AUX);
    if (s.corrupt === "sig") ev.sig = ev.sig.slice(0, -1) + (ev.sig.at(-1) !== "0" ? "0" : "1");
    else if (s.corrupt === "id") ev.content += " (tampered)";
    ev._arrives = s.arrives ?? t;
    events.push(ev);
    ids[s.id] = ev.id;
    byName[s.id] = ev;
  }
  return [events, ids];
}

function expected(exp: Any, ids: Record<string, string>): Any {
  if (exp && typeof exp === "object" && !Array.isArray(exp) && "$min" in exp) return exp.$min.map((n: string) => ids[n]).sort()[0];
  if (exp && typeof exp === "object" && !Array.isArray(exp)) {
    return Object.fromEntries(Object.entries(exp).map(([k, v]) =>
      [k, k === "event" && typeof v === "string" ? (ids[v] ?? v) : expected(v, ids)]));
  }
  return resolve(exp, ids);
}

function partial(want: Any, got: Any, path = "state") {
  if (want !== null && typeof want === "object" && !Array.isArray(want)) {
    assert.ok(got !== null && typeof got === "object", `${path}: expected an object, got ${JSON.stringify(got)}`);
    for (const [k, v] of Object.entries(want)) partial(v, got[k], `${path}.${k}`);
  } else assert.deepStrictEqual(got, want, path);
}

const POLICY = { askers: CASES.policy.askers.map((n: string) => PUB[n]), owner: CASES.policy.owner.map((n: string) => PUB[n]) };
const sortPairs = (xs: string[][]) => [...xs].sort((a, b) => (a.join("\u0000") < b.join("\u0000") ? -1 : 1));

for (const c of CASES.cases) {
  test(c.name, () => {
    const [events, ids] = buildEvents(c.steps);
    const names = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    c.checks.forEach((chk: Any, i: number) => {
      const now = at(chk.now);
      const held = events.filter((e) => e._arrives! <= now).map(({ _arrives, ...e }) => e);
      for (const [order, evs] of [["given", held], ["reversed", [...held].reverse()]] as const) {
        const where = `check ${i} (${order})`;
        if (chk.room !== undefined) {
          const got = roomAsks(evs, now, { ...POLICY, room: chk.room });
          assert.deepStrictEqual(got.map((s) => [names[s.id] ?? s.id, s.state]), chk.list, where);
          continue;
        }
        const st = askState(evs, ids[chk.ask], now, POLICY);
        const { ignored, ...want } = chk.expect;
        partial(expected(want, ids), st, where);
        if (ignored !== undefined) {
          assert.deepStrictEqual(sortPairs(st.ignored.map(([e, r]) => [names[e] ?? e, r])), sortPairs(ignored), where);
        }
      }
    });
  });
}

test("builds", async (t) => {
  const asks: Record<string, Ask> = {};
  for (const [name, spec] of Object.entries(CASES.build_asks)) {
    if (name === "about") continue;
    const s = resolve(spec, {});
    asks[name] = theAsk(signEvent(key(s.by), buildAsk("room-a", s.block, T0), T0, AUX));
  }
  for (const b of CASES.builds) {
    await t.test(b.name, () => {
      const { expect, ...rest } = b;
      const s = resolve(rest, {});
      const args = s.args, now = s.now ?? T0;
      const ask = asks[s.ask];
      const run = () => {
        if (s.fn === "ask") return buildAsk(s.room, args, now);
        if (s.fn === "answer") return buildAnswer(ask, args.a, { pick: args.pick, text: args.text, later: args.later, now });
        if (s.fn === "close") return buildClose(ask, args.why);
        return buildSealedAnswer(ask, args.decision);
      };
      if (b.error) { assert.throws(run, AskError); return; }
      assert.deepStrictEqual(run(), resolve(expect, ask ? { ask: ask.id } : {}));
    });
  }
});

test("pager", async (t) => {
  for (const p of CASES.pager) {
    await t.test(p.name, async () => {
      const events: { id: string; created_at: number }[] = [];
      let n = 0;
      for (const run of p.runs) {
        const start = at(run.from);
        for (let i = 0; i < run.count; i++) events.push({ id: (n++).toString(16).padStart(64, "0"), created_at: start + Math.floor(i / run.per_second) });
      }
      const query = (f: Any) => events.filter((e) => (f.since ?? 0) <= e.created_at && e.created_at <= (p.ignore_until ? 2 ** 62 : (f.until ?? 2 ** 62)))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)).slice(0, Math.min(f.limit, p.relay_cap ?? f.limit));
      const { events: got, truncated } = await readAll(query, { since: T0 - 10 }, p.limit);
      assert.equal(new Set(got.map((e) => e.id)).size, got.length);
      assert.deepStrictEqual([got.length, truncated], [p.expect.count, p.expect.truncated]);
    });
  }
});

test("both languages make the same events (pinned ids)", () => {
  for (const pin of CASES.pins ?? []) {
    const c = CASES.cases.find((x: Any) => x.name === pin.case);
    const [, ids] = buildEvents(c.steps);
    assert.equal(ids[pin.step], pin.id, `${pin.case} / ${pin.step}`);
  }
  assert.equal(bytesToHex(key("uni")).length, 64);
});
