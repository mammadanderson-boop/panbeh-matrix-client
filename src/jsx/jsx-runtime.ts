import { Fragment } from "react";
import * as rt from "react/jsx-runtime";

/* Apple's emoji wherever text is shown: this is the app's JSX runtime (vite.config's jsxImportSource), and it swaps each
   emoji in an element's text for Apple's picture, fetched from jsDelivr the first time it's shown. Message HTML and the
   text boxes (EmoteInput) use emojiSplit / emojiImg themselves. A picture that doesn't load (offline, or an emoji newer
   than Apple's set) becomes the system's emoji, drawn into an SVG. Plain <input>s and native text stay the system's. */

let RE: RegExp | null = null;
try { RE = new RegExp("(\\p{RGI_Emoji})", "v"); } catch { /* an old WebView without the v flag: system emoji */ }

// emoji with no picture (a 404 while online): drawn by the system from then on, without asking again
export const missing = new Set<string>();

const fallback = (u: string) => "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><text x="10" y="16.5" font-size="16" text-anchor="middle">${u}</text></svg>`);

/** iamcal's file names drop an FE0F that the emoji doesn't need (it shows as emoji anyway). */
export const emojiUrl = (u: string) => missing.has(u) ? fallback(u) : "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/" +
  [...u.replace(/(\p{Emoji_Presentation})\uFE0F/gu, "$1")].map((c) => c.codePointAt(0)!.toString(16).padStart(4, "0")).join("-") + ".png";

/** `s` cut into text and emoji: the odd parts are emoji. */
export const emojiSplit = (s: string): string[] => (RE?.test(s) ? s.split(RE) : [s]);

/** An emoji's picture for DOM the app builds itself; `alt` is the emoji, so copying the text keeps it. */
export const emojiImg = (u: string) =>
  Object.assign(document.createElement("img"), { className: "emoji", src: emojiUrl(u), alt: u, draggable: false });

document.addEventListener("error", (e) => {
  const i = e.target;
  // only the src changes, never the DOM, so it's safe on the images React made too
  if (i instanceof HTMLImageElement && i.classList.contains("emoji") && !i.src.startsWith("data:")) { if (navigator.onLine) missing.add(i.alt); i.src = fallback(i.alt); }
}, true);

const SKIP = new Set(["textarea", "option", "title", "style", "script", "pre", "code", "text", "tspan"]);

function emojify(c: unknown, i = 0): unknown {
  if (typeof c === "string") {
    const parts = emojiSplit(c);
    if (parts.length === 1) return c;
    // keyed, in case `c` sits in a list
    return rt.jsxs(Fragment, { children: parts.map((p, j) => (j % 2 ? rt.jsx("img", { className: "emoji", src: emojiUrl(p), alt: p, draggable: false }) : p)) }, "\0e" + i);
  }
  if (!Array.isArray(c)) return c;
  const m = c.map(emojify);
  return m.some((x, j) => x !== c[j]) ? m : c;
}

export function withEmoji(type: unknown, props: any) {
  if ((type === Fragment || (typeof type === "string" && !SKIP.has(type))) && props.children != null) {
    const children = emojify(props.children);
    if (children !== props.children) return { ...props, children };
  }
  return props;
}

export { Fragment };
export const jsx: typeof rt.jsx = (type, props, key) => rt.jsx(type, withEmoji(type, props), key);
export const jsxs: typeof rt.jsxs = (type, props, key) => rt.jsxs(type, withEmoji(type, props), key);
