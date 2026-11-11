// T-335 Arcade's manifest, on applet contract 2 (src/interface/manifest2.ts). This is everything the Arcade reaches:
// the grant card shows these rows, and the applet port (src/interface/port.ts) refuses any call that isn't one of them.
// - the arcade door deals the rounds and keeps the cards, reactions and taste profile on the box;
// - a Ripple answer (typed or spoken) is filed as a journal entry of yours, and the door hears only where it landed;
// - "Open profile" shows you the profile note the door keeps under Taste/.
// Plain data, checked by parseManifest2 when the registry loads (src/interface/applets.ts).
export const ARCADE_MANIFEST = {
  contract: 2,
  id: "arcade",
  name: "Arcade",
  glyph: "◆",
  note: "your cards and taste profile stay on the box",
  access: [
    { door: "arcade", ops: ["home", "rounds", "profile", "media", "react", "distill"] },
    { vault: "home", allow: [
      { path: "Journal/", verbs: ["create"], own: true },
      { path: "Taste/", verbs: ["read"] },
    ] },
  ],
  reach: ["voice"],
  search: [{ what: "games" }],
  screens: [{ id: "home", name: "Arcade" }, { id: "look", name: "A pinned card" }],
} as const;
