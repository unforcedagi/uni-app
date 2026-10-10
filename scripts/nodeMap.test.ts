// T-83: the node view's pure core — status marks, arm layout for 1..8 children, the slot registry fallback.
// Run: node --experimental-strip-types scripts/nodeMap.test.ts
import assert from "node:assert/strict";
import { parseBrief } from "../src/areas/briefCore.ts";
import { parseArea, parseProject } from "../src/areas/areasCore.ts";
import { buildTree } from "../src/areas/treeCore.ts";
import { aliveOf, centreLines, NO_ALIVE, armLayout, boxHitsCircle, circleBox, circlesTouch, labelWidth, markOf, metrics, overlaps, rolledMark, slotFor, tipLayout, type ArmIn, type Box } from "../src/areas/nodeMap.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const entry = (md: string) => ({ brief: parseBrief(md), generatedAt: null, updatedAt: null });

check("mark: needs beats moving beats quiet; no brief is quiet", () => {
  assert.equal(markOf(entry("## Needs you\n- a\n\n## Moving\n- b\n")), "needs");
  assert.equal(markOf(entry("## Needs you\n- nothing recent\n\n## Moving\n- b\n")), "moving");
  assert.equal(markOf(entry("## Now\nQuiet.\n")), "quiet");
  assert.equal(markOf(null), "quiet");
  assert.equal(markOf(undefined), "quiet");
});

check("rolled mark: an arm shows what waits at its tip; briefs match by path only", () => {
  const a = parseArea({ id: "a", path: "Areas/Techne", tags: ["area"], metadata: { status: "foreground" } })!;
  const p = parseProject({ id: "p", path: "Projects/COhere", tags: ["project"], metadata: { status: "foreground", parent: "Areas/Techne" } })!;
  const tree = buildTree([a, p]);
  const briefs = { "Projects/COhere": entry("## Needs you\n- sign-in\n"), "Areas/Techne": entry("## Now\nx\n") };
  assert.equal(rolledMark(tree, briefs, "Areas/Techne"), "needs");
  assert.equal(rolledMark(tree, { "Areas/Techne": briefs["Areas/Techne"] }, "Areas/Techne"), "quiet");
  // a brief filed under a different path (a name collision) changes nothing
  assert.equal(rolledMark(tree, { "Areas/Other/Projects/COhere": briefs["Projects/COhere"] }, "Areas/Techne"), "quiet");
});

const NAMES = ["Techne", "Unforced Development", "Sanctum", "Atlas", "Relationships", "Expression", "Health and Home", "Money"];
const items = (n: number): ArmIn[] => Array.from({ length: n }, (_, i) => ({ name: NAMES[i], mark: (["needs", "moving", "quiet"] as const)[i % 3], background: i >= 3 }));

function boxes(n: number, w: number, h: number, hasParent: boolean) {
  const m = metrics(w, h), list = items(n), arms = armLayout(list, m, hasParent);
  const core = { x: m.cx, y: m.cy, d: m.core }, chip = m.chip, stage: Box = { x: 0, y: 0, w, h };
  return { m, arms, core, chip, stage };
}

for (const [w, h, label] of [[358, 560, "390 px phone"], [820, 640, "portrait"], [1200, 680, "desktop"], [756, 560, "few children, portrait"], [358, 480, "few children, phone"]] as const) {
  for (let n = 1; n <= (label.startsWith("few") ? 2 : 8); n++) for (const hasParent of [false, true]) {
    check(`layout ${label}: ${n} children${hasParent ? " under a parent" : ""} — no overlap, inside the stage`, () => {
      const { m, arms, core, chip, stage } = boxes(n, w, h, hasParent);
      assert.equal(arms.length, n);
      arms.forEach((a, i) => {
        const me = { x: a.x, y: a.y, d: a.d }, nb = circleBox(a.x, a.y, a.d);
        assert.ok(!circlesTouch(me, core), `node ${i} touches the centre`);
        assert.ok(!boxHitsCircle(a.label, core), `label ${i} crosses the centre`);
        if (hasParent) assert.ok(!circlesTouch(me, chip) && !boxHitsCircle(a.label, chip), `node ${i} touches the parent chip`);
        for (const b of [nb, a.label]) assert.ok(b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= stage.w + 0.5 && b.y + b.h <= stage.h + 0.5, `node ${i} leaves the stage ${JSON.stringify(b)}`);
        assert.ok(a.d >= 44, "tap target");
        arms.slice(i + 1).forEach((o, j) => {
          const oc = { x: o.x, y: o.y, d: o.d };
          assert.ok(!circlesTouch(me, oc), `nodes ${i} and ${i + 1 + j} overlap`);
          assert.ok(!overlaps(a.label, o.label), `labels ${i} and ${i + 1 + j} overlap`);
          assert.ok(!boxHitsCircle(a.label, oc) && !boxHitsCircle(o.label, me), `label crosses node ${i}/${i + 1 + j}`);
        });
      });
    });
  }
}

check("a leaf's larger centre clears the parent chip and stays inside the stage", () => {
  for (const [w, h] of [[358, 400], [756, 470], [1076, 470]]) {
    const m = metrics(w, h, true);
    assert.ok(m.core > metrics(w, h).core);
    assert.ok(!circlesTouch({ x: m.cx, y: m.cy, d: m.core }, m.chip, 6), `${w}x${h}: core touches the chip`);
    assert.ok(m.cy + m.core / 2 <= h && m.cx - m.core / 2 >= 0 && m.cx + m.core / 2 <= w);
  }
});

check("layout is deterministic and background children are smaller", () => {
  const m = metrics(1200, 680);
  const list: ArmIn[] = [{ name: "A", mark: "moving", background: false }, { name: "B", mark: "moving", background: true }];
  assert.deepEqual(armLayout(list, m, false), armLayout(list, m, false));
  const [a, b] = armLayout(list, m, false);
  assert.ok(b.d < a.d);
});

check("labels: capped at the label column, never zero", () => {
  const m = metrics(1200, 680);
  assert.ok(labelWidth("x", m) > 0);
  assert.equal(labelWidth("A very long project name that would never fit", m), m.labelW);
});

check("tips: none on a phone, at most three on desktop, inside the stage", () => {
  const phone = boxes(3, 358, 520, false);
  assert.deepEqual(tipLayout(phone.arms[0], 3, phone.m), []);
  const d = boxes(3, 1200, 680, false);
  assert.equal(tipLayout(d.arms[0], 9, d.m).length, 3);
  for (const t of tipLayout(d.arms[0], 3, d.m)) assert.ok(t.x > 0 && t.x < 1200 && t.y > 0 && t.y < 680);
  assert.deepEqual(tipLayout(d.arms[0], 0, d.m), []);
});

check("centre: needs you first, then moving, capped; no brief is not 'nothing'", () => {
  const a = aliveOf(entry("## Now\nx\n\n## Needs you\n- one\n- two\n\n## Moving\n- three\n- four\n"));
  assert.ok(a.has);
  assert.deepEqual(centreLines(a, 3), [{ kind: "needs", text: "one" }, { kind: "needs", text: "two" }, { kind: "moving", text: "three" }]);
  assert.deepEqual(aliveOf(null), NO_ALIVE);
  assert.equal(aliveOf(entry("")).has, false);
  assert.ok(aliveOf(entry("## Now\nQuiet.\n")).has);
});

check("slot registry: a registered area gets its component, every other path falls back (and inherited keys never match)", () => {
  const Mine = () => null;
  const registry = { "Areas/Sanctum": Mine };
  assert.equal(slotFor(registry, "Areas/Sanctum"), Mine);
  assert.equal(slotFor(registry, "Areas/Techne"), null);
  assert.equal(slotFor({}, "Areas/Techne"), null);
  assert.equal(slotFor(registry, "constructor"), null);
  assert.equal(slotFor(registry, "__proto__"), null);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
