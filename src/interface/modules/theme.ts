// theme module: the host's colours and fonts, pushed as a `theme` event on load
// and when the colour scheme changes. Fonts are injected into the srcdoc by
// the host (frameFonts.ts) because the frame's CSP allows only `font-src data:`.

import type { UniModule } from "../router.ts";

export type ThemeData = { text: string; muted: string; accent: string; surface: string; line: string; sans: string; serif: string; mono: string };
export const THEME_VARS: [keyof ThemeData, string][] = [["text", "--text"], ["muted", "--muted"], ["accent", "--accent"], ["surface", "--surface"], ["line", "--line"], ["sans", "--sans"], ["serif", "--serif"], ["mono", "--mono"]];

export function createThemeModule(deps: { theme(): ThemeData }): UniModule {
  return { namespace: "theme", methods: { get: { cap: null, validate: () => ({ ok: true, value: {} }), run: async () => deps.theme() } } };
}
