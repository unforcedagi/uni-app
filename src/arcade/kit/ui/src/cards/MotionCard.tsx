// A movement, drawn live from its MotionSpec (scene, seconds per cycle, easing, amplitude) with the Web Animations API.
// Calm (reduced motion, the ink screen): nothing moves; the scene is drawn as a chronophotograph, each pose a fainter ghost.
import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import type { Card, MotionSpec } from "../../../engine/src/types.ts";
import { useArcade } from "../kit/hooks.ts";

interface El { cls: string; style: CSSProperties; frames: Keyframe[]; delay?: number; alternate?: boolean }

function els(m: MotionSpec): El[] {
  const a = Math.max(0, Math.min(1, m.amplitude));
  switch (m.scene) {
    case "rise":
      return [0, 1, 2, 3, 4].map((i) => ({
        cls: "ta-m-dot", style: { left: `${16 + i * 17}%`, bottom: "8%", width: `${12 + (i % 3) * 5}px`, height: `${12 + (i % 3) * 5}px` },
        frames: [{ transform: "translateY(0cqh) scale(.6)", opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: `translateY(-${30 + 50 * a}cqh) scale(1)`, opacity: 0 }],
        delay: i / 5,
      }));
    case "orbit": {
      const R = 12 + 22 * a;
      return [
        { cls: "ta-m-sun", style: {}, frames: [] },
        { cls: "ta-m-moon", style: {}, frames: [0, 90, 180, 270, 360].map((d) => ({ transform: `rotate(${d}deg) translateX(${R}cqmin)` })) },
        { cls: "ta-m-ring", style: { width: `${R * 2}cqmin`, height: `${R * 2}cqmin` }, frames: [] },
      ];
    }
    case "ripple":
      return [0, 1, 2].map((i) => ({
        cls: "ta-m-ring ta-m-wave", style: {},
        frames: [{ transform: "scale(.12)", opacity: 1 }, { transform: `scale(${0.45 + 0.55 * a})`, opacity: 0 }],
        delay: i / 3,
      })).concat([{ cls: "ta-m-drop", style: {}, frames: [], delay: 0 }]);
    case "bounce":
      return [
        { cls: "ta-m-shadow", style: {}, frames: [{ transform: "scaleX(1)", opacity: 0.5 }, { transform: `scaleX(${1 - 0.5 * a})`, opacity: 0.2 }], alternate: true },
        { cls: "ta-m-ball", style: {}, frames: [{ transform: "translateY(0cqh)" }, { transform: `translateY(-${18 + 46 * a}cqh)` }], alternate: true },
      ];
    case "sway": {
      const A = 4 + 18 * a;
      return [0, 1, 2, 3, 4].map((i) => ({
        cls: "ta-m-stalk", style: { left: `${18 + i * 16}%`, height: `${46 + ((i * 37) % 30)}%` },
        frames: [{ transform: `rotate(${-A}deg)` }, { transform: `rotate(${A}deg)` }], alternate: true, delay: i * 0.08,
      }));
    }
    case "unfold":
    default: {
      const S = 10 + 26 * a;
      return [-2, -1, 0, 1, 2].map((k) => ({
        cls: "ta-m-petal", style: {},
        frames: [{ transform: "rotate(0deg) scaleY(.5)" }, { transform: `rotate(${k * S}deg) scaleY(1)` }], alternate: true,
      }));
    }
  }
}

/** Plain words for a curve: "smooth", "springy", "steady". */
export function easingWord(e: string): string {
  const s = e.toLowerCase();
  if (s.includes("linear")) return "steady";
  const m = /cubic-bezier\(([^)]+)\)/.exec(s);
  if (m) {
    const n = m[1].split(",").map(Number);
    if (n[1] > 1.05 || n[3] > 1.05 || n[1] < -0.05 || n[3] < -0.05) return "springy";
    return n[0] < 0.3 ? "quick to start, soft to land" : "soft";
  }
  if (s.includes("in-out")) return "soft at both ends";
  if (s.includes("out")) return "quick to start, soft to land";
  if (s.includes("in")) return "slow to start";
  return "soft";
}

export function MotionStage({ spec, label }: { spec: MotionSpec; label: string }) {
  const { calm } = useArcade();
  const list = useMemo(() => els(spec), [spec.scene, spec.amplitude]);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (calm || !stage.current) return;
    const nodes = Array.from(stage.current.querySelectorAll<HTMLElement>("[data-m]"));
    const ms = Math.max(200, spec.duration * 1000);
    const anims = nodes.map((n) => {
      const e = list[Number(n.dataset.m)];
      if (!e || !e.frames.length) return null;
      return n.animate(e.frames, { duration: ms, iterations: Infinity, easing: spec.easing || "ease", direction: e.alternate ? "alternate" : "normal", delay: -(e.delay ?? 0) * ms });
    });
    return () => anims.forEach((x) => x?.cancel());
  }, [calm, list, spec.duration, spec.easing]);
  return (
    <div className={`ta-motion${calm ? " is-still" : ""}`} data-scene={spec.scene} ref={stage} role="img" aria-label={label}>
      {list.map((e, i) => {
        if (!calm || !e.frames.length) return <i key={i} data-m={i} className={e.cls} style={e.frames.length ? { ...e.style, ...(e.frames[0] as CSSProperties) } : e.style} />;
        // still: every keyframe as a ghost, fainter the earlier it is
        return e.frames.map((f, k) => (
          <i key={`${i}-${k}`} className={`${e.cls} is-ghost`} style={{ ...e.style, ...(f as CSSProperties), opacity: 0.25 + 0.75 * (k / Math.max(1, e.frames.length - 1)) }} />
        ));
      })}
    </div>
  );
}

export function MotionCard({ card, bare }: { card: Card; bare?: boolean }) {
  const spec: MotionSpec = card.motion ?? { scene: "ripple", duration: 2, easing: "ease-in-out", amplitude: 0.5 };
  const pace = spec.duration >= 3 ? "slow" : spec.duration <= 1 ? "quick" : "easy";
  return (
    <figure className="ta-card ta-card-motion" data-kind="motion">
      <div className="ta-media-frame">
        <MotionStage spec={spec} label={`${card.title}: a ${pace} ${spec.scene}, ${easingWord(spec.easing)}`} />
      </div>
      {!bare && <figcaption className="ta-card-cap">{card.title} <small>{spec.duration}s, {easingWord(spec.easing)}</small></figcaption>}
    </figure>
  );
}
