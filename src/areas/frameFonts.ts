// Web fonts for the sealed frame, as data: URLs (the CSP allows `font-src data:`
// and nothing else). The woff2 files are variable fonts: one file serves every
// weight in its range, so three files cover the six weights the host uses.
import cormorant from "../assets/fonts/CormorantGaramond-normal-400.woff2?inline";
import cormorantItalic from "../assets/fonts/CormorantGaramond-italic-400.woff2?inline";
import inter from "../assets/fonts/Inter-normal-400.woff2?inline";

const face = (family: string, style: string, weight: string, url: string) =>
  `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:swap;src:url(${url}) format('woff2')}`;

export const FRAME_FONT_CSS = `<style>${[
  face("Cormorant Garamond", "normal", "400 600", cormorant),
  face("Cormorant Garamond", "italic", "400", cormorantItalic),
  face("Inter", "normal", "400 600", inter),
].join("")}</style>`;
