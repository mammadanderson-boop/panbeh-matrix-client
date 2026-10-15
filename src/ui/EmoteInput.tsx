import { useEffect, useLayoutEffect, useMemo, useRef, type ClipboardEvent, type HTMLAttributes, type RefObject } from "react";
import { mediaUrl } from "../matrix.ts";
import { emoteRe } from "../logic.ts";
import { tinted } from "./Emoji.tsx";

/* A text box that shows custom emoji as images while speaking plain text: an emoji is its ":code:", a line break "\n".
   Typing is left to the browser; anything structural (a newline, a paste, text set from outside, a typed ":code:"
   turning into its image) lays the box out afresh from the text. */

const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const lastSel = new WeakMap<HTMLElement, [number, number]>(); // the caret while the box isn't focused

/** The text: emoji as ":code:", "\n" as typed. <br>s are only the browser's (or our) placeholders for an empty line. */
export function textOf(n: Node): string {
  let s = "";
  for (const c of n.childNodes) {
    if (c instanceof Text) s += c.data;
    else if (c instanceof HTMLImageElement) s += c.dataset.code ? `:${c.dataset.code}:` : "";
    else if (c instanceof HTMLElement && !(c instanceof HTMLBRElement)) s += (/^(DIV|P)$/.test(c.tagName) && s && !s.endsWith("\n") ? "\n" : "") + textOf(c);
  }
  return s.replaceAll(" ", " "); // the browser's stand-in for a run of spaces
}

/** The DOM spot `off` characters into the text; inside an emoji's code snaps to after it.
 *  ponytail: counts no newline for a nested <div> (textOf does); the box only ever holds them if the browser adds some */
function locate(root: Node, off: number): [Node, number] {
  let left = off;
  const go = (n: Node): [Node, number] | null => {
    for (let i = 0; i < n.childNodes.length; i++) {
      const c = n.childNodes[i];
      if (c instanceof Text) { if (left <= c.length) return [c, left]; left -= c.length; }
      else if (c instanceof HTMLImageElement) {
        const l = (c.dataset.code?.length ?? -2) + 2;
        if (left < l) return [n, left ? i + 1 : i];
        left -= l;
      } else { const r = go(c); if (r) return r; }
    }
    return null;
  };
  return go(root) ?? [root, root.childNodes.length];
}

/** The selection as text offsets (the last one known while unfocused, else the end). */
export function caretOf(el: HTMLElement): [number, number] {
  const s = getSelection();
  if (document.activeElement !== el || !s?.rangeCount || !el.contains(s.anchorNode)) {
    const n = textOf(el).length, [a, b] = lastSel.get(el) ?? [n, n];
    return [Math.min(a, n), Math.min(b, n)];
  }
  const r = s.getRangeAt(0), pre = document.createRange();
  pre.setStart(el, 0);
  pre.setEnd(r.startContainer, r.startOffset);
  const a = textOf(pre.cloneContents()).length;
  return [a, a + textOf(r.cloneContents()).length];
}

/** Puts the selection at text offsets; unfocused, it waits for `focusAt` (moving the DOM selection would focus the box
 *  and raise the phone's keyboard). */
export function placeCaret(el: HTMLElement, a: number, b = a) {
  lastSel.set(el, [a, b]);
  if (document.activeElement !== el) return;
  const r = document.createRange();
  r.setStart(...locate(el, a));
  r.setEnd(...locate(el, b));
  const s = getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

/** Focuses the box with the caret where it was left (or at `a`). */
export function focusAt(el: HTMLElement | null, a?: number) {
  if (!el) return;
  const [x, y] = a == null ? caretOf(el) : [a, a];
  el.focus();
  placeCaret(el, x, y);
}

function emoteEl(code: string, mxc: string) {
  const img = Object.assign(document.createElement("img"), { className: "emote shimmer", alt: `:${code}:`, src: BLANK, draggable: false });
  img.dataset.code = code;
  mediaUrl({ url: mxc })?.then(async (src) => {
    if (await tinted(mxc, src)) { img.classList.add("tint"); img.style.setProperty("--src", `url("${src}")`); }
    img.src = src;
    img.classList.remove("shimmer");
  }, () => {});
  return img;
}

function build(el: HTMLElement, text: string, re: RegExp | null, emotes: ReadonlyMap<string, string>) {
  const parts = re ? text.split(re) : [text]; // odd parts are the captured codes
  el.replaceChildren(...parts.flatMap((p, i): (Node | string)[] => (i % 2 ? [emoteEl(p, emotes.get(p)!)] : p ? [p] : [])),
    ...(text.endsWith("\n") ? [document.createElement("br")] : [])); // holds the empty last line open
}

type Props = Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  value: string;
  onChange: (text: string, caret: number) => void;
  /** the selection moved: its start, and its end (= start when collapsed) */
  onCaret?: (caret: number, end: number) => void;
  /** code → mxc of the custom emoji to show */
  emotes: ReadonlyMap<string, string>;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLDivElement | null>;
};

export function EmoteInput({ value, onChange, onCaret, emotes, placeholder, autoFocus, inputRef, className = "", onPaste, ...rest }: Props) {
  const own = useRef<HTMLDivElement>(null);
  const el = inputRef ?? own;
  const key = [...emotes].flat().join("\n");
  const re = useMemo(() => emoteRe(emotes.keys()), [key]);
  const composing = useRef(false);
  const live = useRef({ re, emotes, onChange, onCaret });
  live.current = { re, emotes, onChange, onCaret };

  const rawCode = (e: HTMLElement) => !!re && [...e.childNodes].some((n) => n instanceof Text && n.data.search(re) >= 0);
  /** Replaces the selection with `s`. */
  function put(s: string) {
    const e = el.current!, t = textOf(e), [a, b] = caretOf(e), next = t.slice(0, a) + s + t.slice(b);
    build(e, next, live.current.re, live.current.emotes);
    placeCaret(e, a + s.length);
    live.current.onChange(next, a + s.length);
  }
  /** After the browser's edit: an emptied box drops its leftover <br> (so the placeholder shows), a typed code becomes its image. */
  function settle() {
    const e = el.current!, t = textOf(e);
    if (!t && e.firstChild) e.replaceChildren();
    else if (rawCode(e)) { const [c] = caretOf(e); build(e, t, re, emotes); placeCaret(e, c); }
    onChange(t, caretOf(e)[0]);
  }

  // controlled, like a textarea: text set from outside (or an edit the parent turned down) is laid out again, the caret
  // at its end (a caller that wants it elsewhere places it after)
  useLayoutEffect(() => {
    const e = el.current!;
    if (composing.current || (textOf(e) === value && !rawCode(e))) return;
    const keep = textOf(e) === value; // only the emoji changed (packs loaded): the caret stays
    const [c] = caretOf(e);
    build(e, value, re, emotes);
    placeCaret(e, keep ? c : value.length);
  });

  useEffect(() => {
    const e = el.current!;
    if (autoFocus) e.focus();
    const before = (ev: InputEvent) => {
      if (ev.inputType === "insertParagraph" || ev.inputType === "insertLineBreak") { ev.preventDefault(); put("\n"); }
      else if (ev.inputType.startsWith("format") || ev.inputType === "insertFromDrop") ev.preventDefault();
    };
    const sel = () => {
      if (document.activeElement !== e) return;
      const c = caretOf(e);
      lastSel.set(e, c);
      live.current.onCaret?.(c[0], c[1]);
    };
    e.addEventListener("beforeinput", before);
    document.addEventListener("selectionchange", sel);
    return () => { e.removeEventListener("beforeinput", before); document.removeEventListener("selectionchange", sel); };
  }, []);

  /** Copy/cut give the text with ":code:", not the images' HTML. */
  function copy(ev: ClipboardEvent, cut: boolean) {
    const s = getSelection();
    if (!s?.rangeCount) return;
    ev.preventDefault();
    ev.clipboardData.setData("text/plain", textOf(s.getRangeAt(0).cloneContents()));
    if (cut) put("");
  }

  return (
    <div {...rest} ref={el} className={"emote-input " + className} contentEditable suppressContentEditableWarning role="textbox" aria-multiline
      data-placeholder={placeholder} aria-placeholder={placeholder}
      onInput={(ev) => { if (!(ev.nativeEvent as InputEvent).isComposing) settle(); else onChange(textOf(el.current!), caretOf(el.current!)[0]); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; settle(); }}
      onCopy={(ev) => copy(ev, false)} onCut={(ev) => copy(ev, true)}
      onPaste={(ev) => { onPaste?.(ev); if (ev.defaultPrevented) return; ev.preventDefault(); put(ev.clipboardData.getData("text/plain")); }} />
  );
}
