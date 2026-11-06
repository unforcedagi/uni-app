// The words a claim is written in. A feature is "<domain>:<slug>"; a claim id is the feature plus a sign ("visual:warm+").
// Unknown features still make claims, in plain words built from the slug.
import type { Domain } from "./types.ts";
import { DOMAINS } from "./types.ts";

type Entry = { pos: string; neg: string };

const L: Record<string, Entry> = {
  // visual: colour
  "visual:warm": { pos: "Warm colour: clay, ember, late sun.", neg: "Warm colour leaves them cold." },
  "visual:cool": { pos: "Cool colour: water, slate, dusk blue.", neg: "Cool, cold palettes don't land." },
  "visual:earthy": { pos: "Earthy, natural colour over synthetic brights.", neg: "Earthy browns and greens feel heavy to them." },
  "visual:earthy-natural": { pos: "Earthy, natural colour over synthetic brights.", neg: "Earthy browns and greens feel heavy to them." },
  "visual:clinical": { pos: "Clean, clinical surfaces.", neg: "Clinical, sterile surfaces: no." },
  "visual:vivid": { pos: "Vivid, saturated colour.", neg: "Loud saturated colour wears on them." },
  "visual:vivid-saturated": { pos: "Vivid, saturated colour.", neg: "Loud saturated colour wears on them." },
  "visual:muted": { pos: "Muted colour, nothing shouting.", neg: "Muted palettes read as timid." },
  "visual:pastel": { pos: "Soft pastels.", neg: "Pastels feel too sweet." },
  "visual:dark": { pos: "Dark grounds, light coming out of them.", neg: "Dark, night-mode looks don't pull." },
  "visual:light-paper": { pos: "Light, paper-like grounds.", neg: "Bright paper-white pages feel flat." },
  "visual:paper": { pos: "Paper-like grounds, soft and light.", neg: "Paper looks feel precious." },
  "visual:monochrome": { pos: "One or two colours, used with discipline.", neg: "Monochrome feels drained." },
  "visual:high-contrast": { pos: "High contrast, decisive edges.", neg: "Harsh contrast grates." },
  "visual:low-contrast": { pos: "Low contrast: close tones, nothing stark.", neg: "Low contrast reads as washed out." },
  "visual:texture-grain": { pos: "Texture and grain: the hand, the material.", neg: "Grain and texture read as fussy." },
  "visual:texture": { pos: "Texture and grain: the hand, the material.", neg: "Grain and texture read as fussy." },
  "visual:photographic": { pos: "Real photographs.", neg: "Stock-like photography leaves them flat." },
  "visual:painterly-illustrated": { pos: "Painted and illustrated images over photos.", neg: "Illustration feels cute to them." },
  "visual:glossy": { pos: "Glossy, polished surfaces.", neg: "Glossy, slick polish: not them." },
  "visual:neon": { pos: "Neon and glow.", neg: "Neon glow feels like a nightclub, not them." },
  "visual:gradient": { pos: "Soft gradients.", neg: "Decorative gradients feel generic." },
  // visual: form and type
  "visual:sparse-layout": { pos: "Sparse layouts with room to breathe.", neg: "Very sparse pages feel empty." },
  "visual:sparse": { pos: "Sparse, breathing layouts.", neg: "Too much empty space feels withholding." },
  "visual:dense": { pos: "Dense, information-rich pages.", neg: "Dense pages feel like work." },
  "visual:dense-information-rich": { pos: "Dense, information-rich pages.", neg: "Dense pages feel like work." },
  "visual:full-bleed-imagery": { pos: "Full-bleed imagery that fills the frame.", neg: "Full-bleed hero images feel like ads." },
  "visual:immersive-canvas": { pos: "Immersive canvases you step into.", neg: "Immersive canvases get in the way." },
  "visual:card-grid": { pos: "Tidy card grids.", neg: "The card-grid kit feels templated." },
  "visual:editorial-grid": { pos: "Editorial grids, magazine rhythm.", neg: "Magazine grids feel stiff." },
  "visual:broken-grid": { pos: "Broken, playful grids.", neg: "Broken grids feel chaotic." },
  "visual:index-list": { pos: "Plain indexes and lists.", neg: "Bare lists feel dry." },
  "visual:single-scroll-story": { pos: "One long scrolling story.", neg: "Long scroll stories drag." },
  "visual:long-form-reading": { pos: "Long-form reading pages.", neg: "Long reading pages feel heavy." },
  "visual:split-screen": { pos: "Split screens.", neg: "Split screens feel busy." },
  "visual:nonlinear-exploratory": { pos: "Non-linear pages you explore.", neg: "Non-linear pages lose them." },
  "visual:horizontal-scroll": { pos: "Sideways scrolling.", neg: "Sideways scrolling fights them." },
  "visual:sidenotes-annotations": { pos: "Sidenotes and annotations.", neg: "Margins full of notes distract." },
  "visual:serif": { pos: "Serif type, bookish and human.", neg: "Serif type feels old-fashioned to them." },
  "visual:book-serif": { pos: "Book serifs for reading.", neg: "Book serifs feel stuffy." },
  "visual:serif-display": { pos: "Big serif display type.", neg: "Serif display type feels precious." },
  "visual:clean-grotesk": { pos: "Clean grotesk sans.", neg: "The clean grotesk look feels like every startup." },
  "visual:sans": { pos: "Plain sans type.", neg: "Plain sans feels anonymous." },
  "visual:oversized-type": { pos: "Oversized type as the main event.", neg: "Huge type shouts." },
  "visual:small-quiet-type": { pos: "Small, quiet type.", neg: "Tiny quiet type is hard to love." },
  "visual:characterful-type": { pos: "Type with character.", neg: "Quirky type tires them." },
  "visual:mono-technical": { pos: "Monospace, technical type.", neg: "Monospace labels feel like a terminal costume." },
  "visual:hand-lettered": { pos: "Hand lettering.", neg: "Hand lettering feels twee." },
  "visual:type-as-image": { pos: "Type used as image.", neg: "Type-as-image feels like a stunt." },
  "visual:round": { pos: "Soft, rounded shapes.", neg: "Rounded corners everywhere feel toy-like." },
  "visual:sharp": { pos: "Sharp corners and hard edges.", neg: "Hard sharp edges feel cold." },
  "visual:organic": { pos: "Organic, grown shapes.", neg: "Organic blobs feel vague." },
  "visual:geometric": { pos: "Geometric order.", neg: "Strict geometry feels rigid." },
  "visual:handmade": { pos: "Things that look made by hand.", neg: "The handmade look feels affected." },
  "visual:explorable-toy": { pos: "Interfaces you can play with like a toy.", neg: "Toy-like interfaces waste their time." },
  "visual:plain-navigation": { pos: "Plain, obvious navigation.", neg: "Plain navigation bores them." },
  "visual:game-like": { pos: "Game-like interaction.", neg: "Gamified interfaces feel manipulative." },
  "visual:direct-manipulation": { pos: "Touch it and it moves: direct manipulation.", neg: "Drag-everything interfaces tire them." },
  "visual:custom-cursor": { pos: "Custom cursors.", neg: "Custom cursors get in the way." },
  "visual:hover-reveals": { pos: "Hover reveals.", neg: "Things hidden behind hovers annoy them." },
  "visual:sound": { pos: "Pages that make sound.", neg: "Pages that make sound intrude." },
  "visual:drag-physics": { pos: "Drag and physics.", neg: "Physics toys feel gimmicky." },
  "visual:micro-interactions": { pos: "Small, satisfying micro-interactions.", neg: "Fidgety micro-interactions distract." },
  "visual:nature": { pos: "Nature in the picture: plants, water, weather.", neg: "Nature imagery feels like a cliché to them." },
  "visual:tech": { pos: "Visible technology: circuits, code, screens.", neg: "Tech imagery feels cold." },
  "visual:corporate": { pos: "A corporate, buttoned-up look.", neg: "Corporate polish: never." },
  // motion
  "motion:slow": { pos: "Slow motion, like breathing.", neg: "Slow motion drags for them." },
  "motion:fast": { pos: "Quick, snappy motion.", neg: "Snappy, fast motion feels nervous." },
  "motion:bouncy": { pos: "Bounce and spring.", neg: "Bounce and spring feel cartoonish." },
  "motion:smooth": { pos: "Smooth, eased motion.", neg: "Over-smoothed motion feels floaty." },
  "motion:still": { pos: "Stillness: pages that don't move.", neg: "Pages with no motion feel dead." },
  "motion:big": { pos: "Big, travelling movement.", neg: "Big sweeping movement is too much." },
  "motion:subtle": { pos: "Subtle movement you half notice.", neg: "Movement so subtle it's pointless." },
  "motion:organic": { pos: "Organic motion: drift, sway, growth.", neg: "Wobbly organic motion feels vague." },
  "motion:mechanical": { pos: "Precise, mechanical motion.", neg: "Mechanical motion feels robotic." },
  "motion:webgl-3d": { pos: "3D and WebGL scenes.", neg: "3D showpieces feel heavy." },
  "motion:generative-live": { pos: "Generative, live-made motion.", neg: "Generative noise feels aimless." },
  "motion:video-led": { pos: "Video-led pages.", neg: "Autoplay video pages wear them out." },
  "motion:scroll-triggered-reveals": { pos: "Reveals as you scroll.", neg: "Scroll-triggered reveals feel like a template." },
  "motion:loader-intro": { pos: "An intro moment before the page.", neg: "Intro loaders waste their time." },
  "motion:cinematic-transitions": { pos: "Cinematic transitions.", neg: "Cinematic transitions feel slow." },
  "motion:micro-interactions": { pos: "Small, satisfying micro-interactions.", neg: "Fidgety micro-interactions distract." },
  "motion:kinetic-type": { pos: "Moving type.", neg: "Moving type is hard to read." },
  "motion:smooth-scroll": { pos: "Smooth scrolling.", neg: "Hijacked smooth scrolling annoys them." },
  // sound
  "sound:acoustic": { pos: "Acoustic sound: wood, breath, strings.", neg: "Acoustic sound feels too folksy." },
  "sound:electronic": { pos: "Electronic sound.", neg: "Electronic sound feels cold." },
  "sound:warm": { pos: "Warm, round sound.", neg: "Warm, soft sound is too mellow." },
  "sound:bright": { pos: "Bright, crisp sound.", neg: "Bright, crisp sound is harsh to them." },
  "sound:sparse": { pos: "Sparse sound with space around it.", neg: "Sparse arrangements feel unfinished." },
  "sound:dense": { pos: "Dense, layered sound.", neg: "Dense layers feel crowded." },
  "sound:voice": { pos: "A human voice in it.", neg: "Vocals get in the way." },
  "sound:field-recording": { pos: "Field recordings: the world as sound.", neg: "Field recordings feel like noise." },
  "sound:drone": { pos: "Drones and long tones.", neg: "Drones feel static." },
  "sound:rhythmic": { pos: "A clear pulse.", neg: "A strong beat pushes too hard." },
  "sound:lofi": { pos: "Lo-fi, worn sound.", neg: "Lo-fi wear feels like a filter." },
  "sound:polished": { pos: "Polished, finished production.", neg: "Over-polished production feels commercial." },
  "sound:slow": { pos: "Slow tempos.", neg: "Slow tempos drag." },
  "sound:fast": { pos: "Quick tempos.", neg: "Quick tempos rush them." },
  // words
  "words:plain": { pos: "Plain words, short sentences.", neg: "Plain words feel flat to them." },
  "words:poetic": { pos: "Poetic, image-led words.", neg: "Poetic copy feels overwritten." },
  "words:corporate": { pos: "Formal, corporate language.", neg: "Corporate language: never." },
  "words:playful": { pos: "Playful words.", neg: "Jokey copy feels forced." },
  "words:earnest": { pos: "Warm, earnest words.", neg: "Earnestness feels sappy." },
  "words:warm-earnest": { pos: "Warm, earnest words.", neg: "Earnestness feels sappy." },
  "words:quiet-minimal": { pos: "Quiet, minimal words.", neg: "Too few words feel cryptic." },
  "words:scholarly": { pos: "Scholarly, careful words.", neg: "Academic words feel distant." },
  "words:technical": { pos: "Technical precision in words.", neg: "Jargon pushes them away." },
  "words:confident-bold": { pos: "Confident, bold claims.", neg: "Bold claims sound like a pitch." },
  "words:irreverent": { pos: "Irreverent words.", neg: "Irreverence feels like posing." },
  "words:spiritual": { pos: "Spiritual language.", neg: "Spiritual language feels vague." },
  "words:hype": { pos: "Big, excited words.", neg: "Hype words: no." },
  "words:short": { pos: "Short sentences.", neg: "Clipped sentences feel curt." },
  "words:long": { pos: "Long, flowing sentences.", neg: "Long sentences lose them." },
  "words:first-person": { pos: "First-person, from a real someone.", neg: "First person feels self-involved." },
  "words:questions": { pos: "Questions over answers.", neg: "Too many questions feel evasive." },
  // systems
  "systems:calm": { pos: "Systems that stay calm: hold, batch, wait.", neg: "Calm systems feel slow to respond." },
  "systems:ambient": { pos: "Ambient over pushy: let things wait to be noticed.", neg: "Ambient systems get missed." },
  "systems:asks-first": { pos: "Ask first, then act.", neg: "Being asked first all the time is friction." },
  "systems:autonomous": { pos: "Trusted to just do it.", neg: "Systems acting alone feel unsafe." },
  "systems:local": { pos: "Local-first: their own machine, their own data.", neg: "Local-first fuss isn't worth it." },
  "systems:open": { pos: "Open: shared, forkable, legible.", neg: "Open by default feels exposed." },
  "systems:playful": { pos: "Systems that are fun to use.", neg: "Fun gets in the way of work." },
  "systems:simple": { pos: "Simple systems with few parts.", neg: "Over-simple systems can't hold life." },
  "systems:rich": { pos: "Rich, layered systems.", neg: "Layered systems feel complicated." },
  "systems:human": { pos: "A human in the loop.", neg: "Human checkpoints slow things." },
};

export function humanize(slug: string): string {
  return slug.replace(/[-_]+/g, " ").trim();
}

export function domainOf(feature: string): Domain | null {
  const d = feature.split(":", 1)[0];
  return (DOMAINS as readonly string[]).includes(d) ? (d as Domain) : null;
}

export function claimText(feature: string, sign: 1 | -1): string {
  const e = L[feature];
  if (e) return sign > 0 ? e.pos : e.neg;
  const word = humanize(feature.slice(feature.indexOf(":") + 1));
  return sign > 0 ? `Leans toward ${word}.` : `Steers away from ${word}.`;
}

/** "quiet / minimal" -> "quiet-minimal" */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function knownFeatures(): string[] {
  return Object.keys(L);
}
