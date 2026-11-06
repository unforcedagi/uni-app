// Something Uni made that's a little off (Fix It), drawn from its params. Any axis works: each one is read for what it
// means (warmth, pace, loudness, room, softness, play, size, spring) from its key, feature and pole words, and the
// drawing follows. An axis we can't read still moves something, so no slider is ever dead.
import type { CSSProperties } from "react";
import type { Artifact, Axis, Card, MotionSpec } from "../../../engine/src/types.ts";
import { MotionStage } from "./MotionCard.tsx";

export type Role = "warmth" | "pace" | "loud" | "room" | "soft" | "play" | "size" | "spring" | "length";

const ROLES: { role: Role; any: RegExp; pos: RegExp; neg: RegExp }[] = [
  { role: "warmth", any: /warm|cool|cold|hue|temperat|earth|sun|ice/, pos: /warm|earth|sun|golden|ember/, neg: /cool|cold|ice|blue|clinical/ },
  { role: "pace", any: /slow|fast|speed|tempo|pace|quick|hurr|calm|rush|snap/, pos: /slow|calm|gentle|unhurr|lazy|easy/, neg: /fast|quick|snap|hurr|rush|brisk/ },
  { role: "spring", any: /bounc|spring|smooth|elastic|jump|jitter/, pos: /bounc|spring|elastic|jump|jitter|playful/, neg: /smooth|still|fluid|steady/ },
  { role: "loud", any: /loud|quiet|bold|vivid|saturat|bright|muted|intens|volume|shout|calm/, pos: /loud|bold|vivid|saturat|bright|intens|shout/, neg: /quiet|muted|soft|calm|whisper|subtle/ },
  { role: "room", any: /dense|sparse|space|air|room|crowd|busy|cramp|tight|breath/, pos: /sparse|space|air|room|breath|open/, neg: /dense|crowd|busy|cramp|tight|packed/ },
  { role: "soft", any: /round|sharp|hard|organic|geometric|corner|edge|soft/, pos: /round|organic|soft|curv/, neg: /sharp|hard|geometric|square|angular/ },
  { role: "play", any: /play|serious|corporate|formal|casual|friendly|stiff|whims|human|warm-earnest|tone/, pos: /play|casual|friendly|whims|human|earnest|warm/, neg: /serious|corporate|formal|stiff|business/ },
  { role: "size", any: /big|small|scale|size|amplitude|travel|subtle|large/, pos: /big|large|bold|travel|more/, neg: /small|subtle|less|tiny/ },
  { role: "length", any: /long|short|word|length|brief|verbose/, pos: /long|verbose|more/, neg: /short|brief|less|terse/ },
];

const FALLBACK: Role[] = ["warmth", "room", "soft", "loud", "play", "size"];

/** Each axis's role and which way is "more" of it. */
export function readAxes(axes: Axis[]): { axis: Axis; role: Role; sign: 1 | -1 }[] {
  const used = new Set<Role>();
  return axes.map((axis) => {
    const all = `${axis.key} ${axis.feature} ${axis.low} ${axis.high}`.toLowerCase();
    const hit = ROLES.find((r) => !used.has(r.role) && r.any.test(all));
    const role = hit?.role ?? FALLBACK.find((r) => !used.has(r)) ?? "size";
    used.add(role);
    let sign: 1 | -1 = 1;
    if (hit) {
      const hi = axis.high.toLowerCase(), lo = axis.low.toLowerCase();
      if (hit.pos.test(lo) || hit.neg.test(hi)) sign = -1;
      if (hit.pos.test(hi) || hit.neg.test(lo)) sign = 1;
    }
    return { axis, role, sign };
  });
}

/** -1..1 per role from the params (missing roles sit at 0). */
export function roleValues(art: Artifact, params: Record<string, number>): Record<Role, number> & { has: Set<Role> } {
  const v: Record<Role, number> & { has: Set<Role> } = { warmth: 0, pace: 0, loud: 0, room: 0, soft: 0, play: 0, size: 0, spring: 0, length: 0, has: new Set() };
  for (const { axis, role, sign } of readAxes(art.axes)) { v[role] = Math.max(-1, Math.min(1, (params[axis.key] ?? 0) * sign)); v.has.add(role); }
  return v;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * ((t + 1) / 2);

function palette(v: Record<Role, number> & { has: Set<Role> }) {
  // warmth turns the hue from slate blue (cool) to ember (warm); without a warmth axis it stays a warm paper
  // loudness turns up saturation and contrast
  const hue = v.has.has("warmth") ? lerp(212, 26, v.warmth) : 34;
  const sat = lerp(14, 72, v.loud);
  const bg = `hsl(${hue.toFixed(0)} ${(sat * 0.7).toFixed(0)}% ${lerp(90, 82, v.loud).toFixed(0)}%)`;
  const ink = `hsl(${hue.toFixed(0)} ${(sat * 0.5).toFixed(0)}% ${lerp(26, 14, v.loud).toFixed(0)}%)`;
  const mark = `hsl(${((hue + 18) % 360).toFixed(0)} ${sat.toFixed(0)}% ${lerp(62, 50, v.loud).toFixed(0)}%)`;
  const mark2 = `hsl(${((hue + 330) % 360).toFixed(0)} ${(sat * 0.8).toFixed(0)}% ${lerp(72, 58, v.loud).toFixed(0)}%)`;
  return { bg, ink, mark, mark2 };
}

function styleVars(v: Record<Role, number> & { has: Set<Role> }): CSSProperties {
  const p = palette(v);
  return {
    ["--a-bg" as string]: p.bg, ["--a-ink" as string]: p.ink, ["--a-mark" as string]: p.mark, ["--a-mark2" as string]: p.mark2,
    ["--a-pad" as string]: `${lerp(5, 15, v.room).toFixed(1)}%`,
    ["--a-gap" as string]: `${lerp(3, 16, v.room).toFixed(1)}px`,
    ["--a-lead" as string]: lerp(1.05, 1.45, v.room).toFixed(2),
    ["--a-radius" as string]: `${lerp(0, 28, v.soft).toFixed(1)}px`,
    ["--a-weight" as string]: lerp(330, 820, v.loud).toFixed(0),
    ["--a-scale" as string]: lerp(0.82, 1.22, v.has.has("size") ? v.size : v.loud * 0.6).toFixed(3),
    ["--a-tilt" as string]: `${lerp(0, -5, v.play).toFixed(2)}deg`,
    ["--a-track" as string]: `${lerp(0.06, -0.02, v.play).toFixed(3)}em`,
    ["--a-soft" as string]: lerp(0, 100, v.play).toFixed(0),
  };
}

function copyFor(art: Artifact, params: Record<string, number>): string {
  const vs = art.variants ?? {};
  const [a, b] = art.axes;
  const side = (x: number) => (x < 0 ? "low" : "high");
  const pa = a ? params[a.key] ?? 0 : 0;
  const pb = b ? params[b.key] ?? 0 : 0;
  if (Math.abs(pa) < 0.33 && Math.abs(pb) < 0.33 && vs.mid) return vs.mid;
  const key = `${side(pa)}-${side(pb)}`;
  return vs[key] ?? vs.mid ?? Object.values(vs)[0] ?? art.text?.title ?? "";
}

export function ArtifactView({ card, params, small }: { card: Card; params: Record<string, number>; small?: boolean }) {
  const art = card.artifact!;
  const v = roleValues(art, params);
  const style = styleVars(v);
  const playful = v.play > 0.15;
  const label = `${card.title}, as it stands`;
  if (art.template === "copy") {
    return (
      <figure className={`ta-art ta-art-copy${playful ? " is-playful" : ""}${small ? " is-small" : ""}`} style={style} aria-label={label}>
        <div className="ta-art-sheet">
          {art.text?.title && <p className="ta-art-kicker">{art.text.title}</p>}
          <p className="ta-art-words" aria-live={small ? undefined : "polite"}>{copyFor(art, params)}</p>
          <span className="ta-art-button" aria-hidden="true">{art.text?.body ?? "Continue"}</span>
        </div>
      </figure>
    );
  }
  if (art.template === "motion") {
    const spec: MotionSpec = {
      scene: card.motion?.scene ?? "bounce",
      duration: Math.round(lerp(0.5, 4.5, v.pace) * 10) / 10,
      easing: v.spring > 0.1 ? `cubic-bezier(.3, ${(1 + v.spring * 0.9).toFixed(2)}, .5, 1)` : v.spring < -0.1 ? "cubic-bezier(.45, 0, .25, 1)" : "ease-in-out",
      amplitude: Math.max(0.05, Math.min(1, (v.size + 1) / 2)),
    };
    return (
      <figure className={`ta-art ta-art-motion${small ? " is-small" : ""}`} style={style} aria-label={label}>
        <div className="ta-art-sheet"><MotionStage spec={spec} label={`${card.title}: ${spec.duration}s per cycle`} /></div>
      </figure>
    );
  }
  if (art.template === "layout") {
    return (
      <figure className={`ta-art ta-art-layout${playful ? " is-playful" : ""}${small ? " is-small" : ""}`} style={style} aria-label={label}>
        <div className="ta-art-sheet">
          <div className="ta-art-nav"><b /><i /><i /><i /></div>
          <p className="ta-art-title">{art.text?.title ?? card.title}</p>
          {art.text?.body && <p className="ta-art-body">{art.text.body}</p>}
          <div className="ta-art-grid">{[0, 1, 2, 3, 4, 5].map((i) => <span key={i}><b /><i /><i /></span>)}</div>
        </div>
      </figure>
    );
  }
  // poster
  return (
    <figure className={`ta-art ta-art-poster${playful ? " is-playful" : ""}${small ? " is-small" : ""}`} style={style} aria-label={label}>
      <div className="ta-art-sheet">
        <div className="ta-art-shapes" aria-hidden="true"><i /><i /><i /></div>
        <p className="ta-art-title">{art.text?.title ?? card.title}</p>
        {art.text?.body && <p className="ta-art-body">{art.text.body}</p>}
      </div>
    </figure>
  );
}
