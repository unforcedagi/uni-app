// The six toys' living pictures, drawn in SVG. Each moves in its own way (slowly, and only when motion is welcome);
// on the ink screen they hold still as line drawings. The Garden's picture is drawn from the real profile.
import type { Claim } from "../../../engine/src/types.ts";
import { DOMAINS } from "../../../engine/src/types.ts";
import { PlantArt } from "../games/Garden.tsx";

export function ToyThisOrThat() {
  return (
    <svg viewBox="0 0 200 140" className="ta-art-tot" aria-hidden="true">
      <g className="ta-tot-l"><rect x="30" y="26" width="64" height="86" rx="10" className="ta-fill-a" /><circle cx="62" cy="58" r="13" className="ta-fill-paper" /><path d="M38 100 q24 -26 48 0" className="ta-stroke-paper" /></g>
      <g className="ta-tot-r"><rect x="106" y="26" width="64" height="86" rx="10" className="ta-fill-b" /><rect x="118" y="44" width="40" height="8" rx="4" className="ta-fill-paper" /><rect x="118" y="60" width="28" height="8" rx="4" className="ta-fill-paper" /><rect x="118" y="76" width="34" height="8" rx="4" className="ta-fill-paper" /></g>
      <circle cx="100" cy="122" r="7" className="ta-fill-ink ta-tot-dot" />
    </svg>
  );
}

export function ToyGallery() {
  return (
    <svg viewBox="0 0 160 180" className="ta-art-gal" aria-hidden="true">
      <path d="M22 172 V78 a58 58 0 0 1 116 0 V172 Z" className="ta-fill-sky" />
      <circle cx="104" cy="70" r="13" className="ta-fill-paper ta-gal-moon" />
      <path d="M22 140 q30 -26 62 -6 t54 -10 V172 H22 Z" className="ta-fill-a" />
      <path d="M22 156 q40 -20 80 -4 t36 0 V172 H22 Z" className="ta-fill-b" />
      <g className="ta-gal-frame"><rect x="40" y="58" width="34" height="26" rx="3" className="ta-fill-paper ta-stroke-ink" /><path d="M44 80 l9 -10 8 7 5 -4 6 7" className="ta-stroke-ink" /></g>
      <path d="M22 172 V78 a58 58 0 0 1 116 0 V172" className="ta-stroke-ink ta-thick" />
    </svg>
  );
}

export function ToyFixIt() {
  return (
    <svg viewBox="0 0 200 140" className="ta-art-fix" aria-hidden="true">
      <g className="ta-fix-poster"><rect x="58" y="12" width="84" height="74" rx="4" className="ta-fill-a" /><circle cx="84" cy="40" r="12" className="ta-fill-b" /><rect x="70" y="62" width="58" height="7" rx="3" className="ta-fill-paper" /></g>
      <line x1="28" y1="108" x2="172" y2="108" className="ta-stroke-ink ta-thick" />
      <line x1="28" y1="126" x2="172" y2="126" className="ta-stroke-ink ta-thin" />
      <g className="ta-fix-knob"><circle cx="70" cy="108" r="9" className="ta-fill-paper ta-stroke-ink" /></g>
      <g className="ta-fix-knob2"><circle cx="130" cy="126" r="7" className="ta-fill-ink" /></g>
    </svg>
  );
}

export function ToyWho() {
  return (
    <svg viewBox="0 0 200 140" className="ta-art-who" aria-hidden="true">
      <text x="18" y="92" className="ta-who-mark">“</text>
      <g className="ta-who-b1"><path d="M70 28 h96 a12 12 0 0 1 12 12 v26 a12 12 0 0 1 -12 12 h-70 l-14 12 v-12 h-12 a12 12 0 0 1 -12 -12 v-26 a12 12 0 0 1 12 -12 Z" className="ta-fill-paper ta-stroke-ink" />
        <circle cx="100" cy="53" r="4" className="ta-fill-ink ta-who-dot" /><circle cx="116" cy="53" r="4" className="ta-fill-ink ta-who-dot" /><circle cx="132" cy="53" r="4" className="ta-fill-ink ta-who-dot" /></g>
      <g className="ta-who-b2"><path d="M84 92 h70 a10 10 0 0 1 10 10 v14 a10 10 0 0 1 -10 10 h-70 a10 10 0 0 1 -10 -10 v-14 a10 10 0 0 1 10 -10 Z" className="ta-fill-a" /><rect x="88" y="105" width="44" height="6" rx="3" className="ta-fill-paper" /></g>
    </svg>
  );
}

export function ToyRipple() {
  return (
    <svg viewBox="0 0 180 180" className="ta-art-rip" aria-hidden="true">
      <circle cx="90" cy="90" r="22" className="ta-rip-r ta-stroke-ink" />
      <circle cx="90" cy="90" r="44" className="ta-rip-r ta-stroke-ink" />
      <circle cx="90" cy="90" r="66" className="ta-rip-r ta-stroke-ink" />
      <circle cx="90" cy="90" r="9" className="ta-fill-a ta-rip-drop" />
    </svg>
  );
}

export function ToyGarden({ claims, seeds }: { claims: Claim[]; seeds: number }) {
  const live = claims.filter((c) => c.status === "live");
  const byBed = DOMAINS.map((d) => live.filter((c) => c.domain === d).sort((a, b) => b.weight - a.weight).slice(0, 3));
  const dots = Math.min(40, seeds);
  return (
    <div className="ta-art-gdn" aria-hidden="true">
      {byBed.map((plants, i) => (
        <div key={DOMAINS[i]} className="ta-mini-bed" data-domain={DOMAINS[i]}>
          {plants.length ? plants.map((c, k) => <span key={c.id} className="ta-mini-plant" style={{ ["--i" as string]: i * 3 + k }}><PlantArt claim={c} scale={0.62} /></span>)
            : <span className="ta-mini-sprout" />}
        </div>
      ))}
      <div className="ta-mini-soil">{Array.from({ length: dots }, (_, k) => <i key={k} style={{ left: `${(k * 37) % 100}%`, top: `${20 + ((k * 53) % 60)}%` }} />)}</div>
    </div>
  );
}
