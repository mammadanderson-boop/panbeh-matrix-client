import { lang, rtl, t, type Key } from "../i18n.ts";
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent as RPE, type ReactNode } from "react";
import type { Room } from "matrix-js-sdk";
import { Icon, type IconName } from "../icons.tsx";
import { pushBack } from "../back.ts";
import { num, textDir } from "../logic.ts";
import { mediaUrl, type Emote } from "../matrix.ts";
import { emojiUrl } from "../jsx/jsx-runtime.ts";
import { confirmDialog } from "./dialog.tsx";
import { toast } from "./common.tsx";
import { EmojiPanel } from "./Emoji.tsx";
import { reducedMotion } from "./useDismiss.ts";
import {
  ADJUST, ASPECTS, FONTS, I, LINE, UNIPOLAR, apply, aspectRatio, blank, chain, contrast, cropFits, cropToRatio, decode, edits, exportEdit,
  fitCrop, glMax, image, inv, isBlank, limitCrop, mirror, mirroredView, mul, objMatrix, objSize, orient, PREVIEW, Renderer, rotate, scale,
  scaleOf, screenRot, translate, turnLeft, turned, upright,
  type AdjustKey, type Align, type Aspect, type EditState, type Font, type Mat, type Obj, type Rect, type ShapeKind, type ShapeObj, type Stroke,
  type TextObj, type TextStyle,
} from "../imageEdit.ts";

type Tool = "crop" | "draw" | "text" | "sticker" | "shapes" | "adjust" | "blur";
type Pen = "pen" | "marker" | "neon" | "arrow" | "eraser";
type Prefs = {
  pen: Pen; blur: "blur" | "pixelate"; shape: ShapeKind; fill: boolean; font: Font; style: TextStyle; align: Align;
  color: { draw: string; text: string; shape: string }; size: Record<Pen | "blur" | "shape", number>; recent: string[];
};
const DEFAULTS: Prefs = {
  pen: "pen", blur: "blur", shape: "rect", fill: false, font: "bold", style: "outline", align: "center",
  color: { draw: "#ff3b30", text: "#ffffff", shape: "#ff3b30" }, size: { pen: 15, marker: 30, neon: 20, arrow: 15, eraser: 40, blur: 70, shape: 12 }, recent: [],
};
const PREFS = "panbeh.editor";
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}");
    return { ...DEFAULTS, ...p, color: { ...DEFAULTS.color, ...p.color }, size: { ...DEFAULTS.size, ...p.size } };
  } catch { return DEFAULTS; }
}

const TABS: [Tool, IconName, Key][] = [["crop", "crop", "edit.crop"], ["draw", "brush", "edit.draw"], ["text", "text", "edit.text"], ["sticker", "smile", "edit.sticker"],
  ["shapes", "shapes", "edit.shapes"], ["adjust", "adjust", "edit.adjust"], ["blur", "blur", "edit.blur"]];
const PENS: [Pen, IconName, Key][] = [["pen", "pencil", "edit.pen"], ["marker", "marker", "edit.marker"], ["neon", "neon", "edit.neon"], ["arrow", "arrow", "edit.arrow"], ["eraser", "eraser", "edit.eraser"]];
const SHAPES: [ShapeKind, IconName, Key][] = [["rect", "rect", "edit.rect"], ["ellipse", "ellipse", "edit.ellipse"], ["line", "line", "edit.line"], ["arrow", "arrow", "edit.arrow"]];
const SWATCHES = ["#ffffff", "#000000", "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#32ade6", "#007aff", "#af52de", "#ff2d55"];
const FONT_ORDER: Font[] = ["bold", "regular", "black", "serif", "mono"];
const STYLES: [TextStyle, Key][] = [["outline", "edit.styleOutline"], ["box", "edit.styleBox"], ["plain", "edit.stylePlain"]];
const ALIGNS: Align[] = ["center", "start", "end"];
const next = <T,>(list: T[], v: T) => list[(list.indexOf(v) + 1) % list.length];
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** A brush size (1…100) as its width on screen, px. */
const brushPx = (v: number) => 2 + v * 0.38;
const open = (o: Obj) => o.kind === "shape" && (o.shape === "line" || o.shape === "arrow");
const tabOf = (o: Obj): Tool => (o.kind === "text" ? "text" : o.kind === "sticker" ? "sticker" : "shapes");
const SNAP = (4 * Math.PI) / 180, HALF = Math.PI / 2;
const signed = (v: number) => (v > 0 ? "+" : "") + num(v);
const vibrate = (ms = 10) => navigator.vibrate?.(ms);

/** source → screen matrices eased from one to another about the photo's centre: turns turn, mirrors fold. */
function decompose(m: Mat, cx: number, cy: number) {
  const [px, py] = apply(m, cx, cy), sy = Math.hypot(m[2], m[3]), th = Math.atan2(-m[2], m[3]);
  return { px, py, th, sx: m[0] * Math.cos(th) + m[1] * Math.sin(th), sy };
}
function between(a: Mat, b: Mat, k: number, cx: number, cy: number): Mat {
  const p = decompose(a, cx, cy), q = decompose(b, cx, cy), l = (x: number, y: number) => x + (y - x) * k;
  let dth = q.th - p.th;
  dth -= Math.round(dth / (2 * Math.PI)) * 2 * Math.PI;
  return chain(translate(l(p.px, q.px), l(p.py, q.py)), rotate(p.th + dth * k), scale(l(p.sx, q.sx), l(p.sy, q.sy)), translate(-cx, -cy));
}

type Knob = "scale" | "end0" | "end1" | "l" | "r" | "t" | "b";
type Pt = [number, number];
type Gest =
  | { kind: "stroke"; id: number; st: Stroke; t0: number; last: Pt }
  | { kind: "view"; z0: number; x0: number; y0: number; a0: Pt; b0?: Pt }
  | { kind: "cropHandle"; hx: number; hy: number; c0: Rect; p0: Pt; k: number }
  | { kind: "cropPan"; c0: Rect; p0: Pt; k: number }
  | { kind: "cropPinch"; c0: Rect; a0: Pt; b0: Pt; k: number }
  | { kind: "move"; o0: Obj; p0: Pt; moved: boolean; wasSel: boolean; hot: boolean; snap: string }
  | { kind: "knob"; knob: Knob; o0: Obj; p0: Pt; snap: boolean }
  | { kind: "pinch"; o0: Obj; a0: Pt; b0: Pt; snap: boolean }
  | { kind: "newShape"; a: Pt; id: number; made: boolean }
  | { kind: "tap"; p0: Pt; moved: boolean }
  | { kind: "compare" } | { kind: "pick" } | { kind: "none" };

/** The photo editor. `file`: a photo, or one edited before (its original and layers come back). Done gives the
 *  edited file (the same file if nothing changed); cancel gives null. avatar: a square crop shown as a circle. */
export function ImageEditor({ file, room, avatar, done }: { file: File; room?: Room; avatar?: boolean; done: (f: File | null) => void }) {
  const prev = edits.get(file), original = prev?.original ?? file;
  const [ready, setReady] = useState(false);
  const R = useRef<Renderer | null>(null);
  const dims = useRef({ W: 1, H: 1 });
  const hist = useRef({ past: [] as EditState[], now: blank(1, 1), future: [] as EditState[], before: null as EditState | null, first: blank(1, 1) });
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [tool, setToolState] = useState<Tool>(avatar ? "crop" : "draw");
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const [sel, setSel] = useState<number | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const [prefs, setPrefsState] = useState(loadPrefs);
  const [textEdit, setTextEdit] = useState<{ o: TextObj; isNew: boolean } | null>(null);
  const [panel, setPanel] = useState(false);
  const [sheet, setSheet] = useState<{ color: string; apply: (c: string) => void } | null>(null);
  const [picking, setPicking] = useState<((c: string) => void) | null>(null);
  const [adj, setAdj] = useState<AdjustKey>("brightness");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [straightening, setStraightening] = useState(false);

  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const bin = useRef<HTMLDivElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 1, h: 1 });
  const zoom = useRef({ z: 1, x: 0, y: 0 });
  const frozen = useRef<Mat | null>(null); // the crop frame's view, held still while a handle is dragged
  const anim = useRef<{ from: Mat; t0: number } | null>(null);
  const shown = useRef<Mat>(I); // source → screen as last drawn
  const G = useRef<Gest | null>(null);
  const P = useRef(new Map<number, Pt>());
  const comparing = useRef(false);
  const space = useRef(false);
  const ids = useRef(1);
  const raf = useRef(0);
  const wheelEnd = useRef(0);
  // the canvas and the listeners set up once always reach this render's functions
  const drawRef = useRef(() => {});
  const wheelRef = useRef((_: WheelEvent) => {});
  const invalidate = useRef(() => { if (!raf.current) raf.current = requestAnimationFrame(() => drawRef.current()); }).current;

  const S = () => hist.current.now;
  const setPrefs = (f: (p: Prefs) => Prefs) => setPrefsState((p) => {
    const n = f(p);
    try { localStorage.setItem(PREFS, JSON.stringify(n)); } catch { /* storage blocked */ }
    return n;
  });

  // ---------- history: live changes during a gesture, one undo step at its end ----------
  function live(next: EditState, quiet = false) {
    const h = hist.current;
    h.before ??= h.now;
    h.now = next;
    if (!quiet) bump();
    invalidate();
  }
  function commit(next = hist.current.now) {
    const h = hist.current, before = h.before ?? h.now;
    h.before = null;
    h.now = next;
    if (next !== before) { h.past = [...h.past.slice(-99), before]; h.future = []; }
    bump();
    invalidate();
  }
  function cancelLive() {
    const h = hist.current;
    if (h.before) { h.now = h.before; h.before = null; }
    bump();
    invalidate();
  }
  function step(back: boolean) {
    const h = hist.current;
    if (h.before) commit();
    const from = back ? h.past : h.future;
    if (!from.length) return;
    animate();
    if (back) { h.future = [h.now, ...h.future]; h.now = h.past.at(-1)!; h.past = h.past.slice(0, -1); }
    else { h.past = [...h.past, h.now]; h.now = h.future[0]; h.future = h.future.slice(1); }
    if (selRef.current != null && !h.now.objects.some((o) => o.id === selRef.current)) setSel(null);
    bump();
    invalidate();
  }
  const objOf = (id: number | null) => S().objects.find((o) => o.id === id);
  const withObj = (o: Obj, s = S()): EditState => ({ ...s, objects: s.objects.map((x) => (x.id === o.id ? o : x)) });
  const without = (id: number, s = S()): EditState => ({ ...s, objects: s.objects.filter((x) => x.id !== id) });

  // ---------- loading ----------
  useEffect(() => {
    let gone = false;
    const fonts = ["400", "700", "900"].map((w) => document.fonts.load(`${w} 20px "Vazirmatn Variable"`).catch(() => {}));
    Promise.all([decode(original, PREVIEW), ...fonts]).then(([d]) => {
      const { pic, W, H } = d as Awaited<ReturnType<typeof decode>>;
      if (gone) return;
      dims.current = { W, H };
      R.current = new Renderer(pic, W, H, invalidate);
      let s0 = prev?.state ?? blank(W, H);
      if (avatar && !prev) s0 = { ...s0, aspect: "1:1", crop: cropToRatio(s0.crop, 1, W, H, 0) };
      hist.current = { past: [], now: s0, future: [], before: null, first: s0 };
      ids.current = Math.max(0, ...s0.objects.map((o) => o.id)) + 1;
      setReady(true);
    }, () => { if (!gone) { toast(t("edit.cantOpen")); done(null); } });
    return () => { gone = true; R.current?.dispose(); cancelAnimationFrame(raf.current); };
  }, []);

  useLayoutEffect(() => {
    const el = stage.current!, c = cv.current!;
    const fit = () => {
      const r = el.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height };
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
      invalidate();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    // ctrl+wheel (a trackpad pinch) would zoom the page: only a non-passive listener can stop it
    const wheel = (e: WheelEvent) => { e.preventDefault(); wheelRef.current(e); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener("wheel", wheel); };
  }, []);
  useEffect(invalidate);

  // ---------- view ----------
  /** Canvas space → screen: the crop fitted to the stage, then (outside the crop tool) the user's zoom. */
  function cropView(s: EditState, tl = toolRef.current): Mat {
    const { w, h } = size.current, c = s.crop, pad = tl === "crop" ? 28 : 0;
    const k = Math.min((w - 2 * pad) / c.w, (h - 2 * pad) / c.h);
    const m = chain(translate(w / 2, h / 2), scale(k), translate(-(c.x + c.w / 2), -(c.y + c.h / 2)));
    if (tl === "crop") return m;
    const z = zoom.current;
    return chain(translate(w / 2 + z.x, h / 2 + z.y), scale(z.z), translate(-w / 2, -h / 2), m);
  }
  const { W, H } = dims.current;
  const target = () => mul(frozen.current ?? cropView(S()), orient(S(), dims.current.W, dims.current.H));
  function animate() { if (!reducedMotion()) anim.current = { from: shown.current, t0: performance.now() }; }
  function current(): Mat {
    const to = target(), a = anim.current;
    if (!a) return to;
    const k = (performance.now() - a.t0) / 240;
    if (k >= 1) { anim.current = null; return to; }
    return between(a.from, to, 1 - (1 - k) ** 3, dims.current.W / 2, dims.current.H / 2);
  }
  const toSource = (p: Pt) => apply(inv(shown.current), p[0], p[1]);

  // ---------- drawing ----------
  function draw() {
    raf.current = 0;
    const c = cv.current, r = R.current;
    if (!c || !r) return;
    const g = c.getContext("2d")!, dpr = devicePixelRatio || 1, s = S(), tl = toolRef.current, gs = G.current;
    const M = current();
    shown.current = M;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    r.draw(g, s, mul(scale(dpr), M), { clip: tl !== "crop", original: comparing.current, active: gs?.kind === "stroke" ? gs.st : null, hide: textEdit?.o.id });
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const toScreen = mul(M, inv(orient(s, dims.current.W, dims.current.H)));
    if (tl === "crop") cropUI(g, toScreen, s, !!gs && gs.kind.startsWith("crop") || straightening);
    const o = objOf(selRef.current);
    if (o && !picking && tl !== "crop") selection(g, M, o);
    if (gs?.kind === "move" && gs.snap) { // centre guides
      const [fx, fy] = apply(toScreen, s.crop.x + s.crop.w / 2, s.crop.y + s.crop.h / 2);
      g.strokeStyle = "rgba(255, 214, 10, 0.9)"; g.lineWidth = 1;
      g.beginPath();
      if (gs.snap.includes("x")) { g.moveTo(fx, 0); g.lineTo(fx, size.current.h); }
      if (gs.snap.includes("y")) { g.moveTo(0, fy); g.lineTo(size.current.w, fy); }
      g.stroke();
    }
    placeBar(M, o);
    if (anim.current) invalidate();
  }
  drawRef.current = draw;

  function cropUI(g: CanvasRenderingContext2D, toScreen: Mat, s: EditState, active: boolean) {
    const c = s.crop, q = [[c.x, c.y], [c.x + c.w, c.y], [c.x + c.w, c.y + c.h], [c.x, c.y + c.h]].map(([x, y]) => apply(toScreen, x, y));
    const { w, h } = size.current, at = (i: number, j: number, k: number) => [q[i][0] + (q[j][0] - q[i][0]) * k, q[i][1] + (q[j][1] - q[i][1]) * k];
    const poly = () => { g.moveTo(q[0][0], q[0][1]); for (const p of q.slice(1)) g.lineTo(p[0], p[1]); g.closePath(); };
    g.fillStyle = "rgba(0, 0, 0, 0.62)";
    g.beginPath();
    g.rect(0, 0, w, h);
    if (avatar) {
      const [cx, cy] = at(0, 2, 0.5);
      g.ellipse(cx, cy, Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) / 2, Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) / 2, Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]), 0, Math.PI * 2);
    } else poly();
    g.fill("evenodd");
    g.strokeStyle = "rgba(255, 255, 255, 0.85)"; g.lineWidth = 1;
    g.beginPath(); poly(); g.stroke();
    if (active) { // thirds
      g.strokeStyle = "rgba(255, 255, 255, 0.45)";
      g.beginPath();
      for (const k of [1 / 3, 2 / 3]) {
        const [a, b] = [at(0, 1, k), at(3, 2, k)], [e, f] = [at(0, 3, k), at(1, 2, k)];
        g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.moveTo(e[0], e[1]); g.lineTo(f[0], f[1]);
      }
      g.stroke();
    }
    g.strokeStyle = "#fff"; g.lineWidth = 3; g.lineCap = "round";
    g.beginPath();
    for (let i = 0; i < 4; i++) { // L-shaped corners
      const p = q[i], a = q[(i + 1) % 4], b = q[(i + 3) % 4], la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
      const L = Math.min(18, la / 3, lb / 3);
      g.moveTo(p[0] + (a[0] - p[0]) / la * L, p[1] + (a[1] - p[1]) / la * L); g.lineTo(p[0], p[1]); g.lineTo(p[0] + (b[0] - p[0]) / lb * L, p[1] + (b[1] - p[1]) / lb * L);
    }
    if (s.aspect === "free" && !avatar) for (let i = 0; i < 4; i++) { // edge bars
      const j = (i + 1) % 4, len = Math.hypot(q[j][0] - q[i][0], q[j][1] - q[i][1]);
      if (len < 80) continue;
      const [a, b] = [at(i, j, 0.5 - 9 / len), at(i, j, 0.5 + 9 / len)];
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    }
    g.stroke();
  }

  function knobs(o: Obj, M: Mat): [Knob, number, number][] {
    const om = mul(M, objMatrix(o)), { w, h } = objSize(o), pad = 8 / scaleOf(om);
    if (o.kind === "shape" && open(o)) return [["end0", ...apply(om, -o.w / 2, 0)], ["end1", ...apply(om, o.w / 2, 0)]];
    const k: [Knob, number, number][] = [["scale", ...apply(om, w / 2 + pad, h / 2 + pad)]];
    if (o.kind === "shape") k.push(["r", ...apply(om, w / 2 + pad, 0)], ["l", ...apply(om, -w / 2 - pad, 0)], ["b", ...apply(om, 0, h / 2 + pad)], ["t", ...apply(om, 0, -h / 2 - pad)]);
    return k;
  }
  /** The object's dashed box (none for lines), its knobs. */
  function selection(g: CanvasRenderingContext2D, M: Mat, o: Obj) {
    const om = mul(M, objMatrix(o)), { w, h } = objSize(o), pad = 8 / scaleOf(om);
    g.save();
    g.shadowColor = "rgba(0, 0, 0, 0.5)"; g.shadowBlur = 3;
    if (!open(o)) {
      const q = [[-w / 2 - pad, -h / 2 - pad], [w / 2 + pad, -h / 2 - pad], [w / 2 + pad, h / 2 + pad], [-w / 2 - pad, h / 2 + pad]].map(([x, y]) => apply(om, x, y));
      g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.setLineDash([6, 4]);
      g.beginPath(); g.moveTo(q[0][0], q[0][1]); for (const p of q.slice(1)) g.lineTo(p[0], p[1]); g.closePath(); g.stroke();
      g.setLineDash([]);
    }
    for (const [k, x, y] of knobs(o, M)) {
      g.fillStyle = "#fff";
      g.beginPath(); g.arc(x, y, k === "scale" || k.startsWith("end") ? 8 : 5.5, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }
  /** The selected object's little bar sits over it (under it near the top), hidden mid-gesture. */
  function placeBar(M: Mat, o?: Obj) {
    const el = bar.current;
    if (!el) return;
    const gs = G.current, hide = !o || !!gs && gs.kind !== "none" && gs.kind !== "tap" || tool === "crop" || !!picking;
    el.classList.toggle("hidden", hide);
    if (hide || !o) return;
    const om = mul(M, objMatrix(o)), { w, h } = objSize(o);
    const q = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => apply(om, x, y));
    const top = Math.min(...q.map((p) => p[1])), bottom = Math.max(...q.map((p) => p[1])), cx = q.reduce((a, p) => a + p[0], 0) / 4;
    const bw = el.offsetWidth, bh = el.offsetHeight, { w: sw, h: sh } = size.current;
    const y = top - bh - 18 > 4 ? top - bh - 18 : Math.min(bottom + 18, sh - bh - 4);
    el.style.transform = `translate(${clamp(cx - bw / 2, 4, sw - bw - 4)}px, ${y}px)`;
  }

  // ---------- hit tests ----------
  function cropHandle(p: Pt) {
    const s = S(), q = mul(shown.current, inv(orient(s, dims.current.W, dims.current.H)));
    const [x0, y0] = apply(q, s.crop.x, s.crop.y), [x1, y1] = apply(q, s.crop.x + s.crop.w, s.crop.y + s.crop.h);
    const near = (a: number, b: number) => Math.abs(a - b) < 24;
    const hx = near(p[0], x0) ? -1 : near(p[0], x1) ? 1 : 0, hy = near(p[1], y0) ? -1 : near(p[1], y1) ? 1 : 0;
    const inX = p[0] > x0 - 24 && p[0] < x1 + 24, inY = p[1] > y0 - 24 && p[1] < y1 + 24;
    return inX && inY && (hx || hy) ? { hx, hy } : null;
  }
  function objAt(p: Pt) {
    const M = shown.current;
    for (const o of [...S().objects].reverse()) {
      const om = mul(M, objMatrix(o)), [x, y] = apply(inv(om), p[0], p[1]), { w, h } = objSize(o), tol = 10 / scaleOf(om);
      if (Math.abs(x) <= w / 2 + tol && Math.abs(y) <= (open(o) ? Math.max(h / 2, 16 / scaleOf(om)) : h / 2 + tol)) return o;
    }
    return null;
  }
  function knobAt(o: Obj, p: Pt) {
    return knobs(o, shown.current).find(([, x, y]) => Math.hypot(p[0] - x, p[1] - y) < 22)?.[0] ?? null;
  }

  // ---------- gestures ----------
  const ptOf = (e: { clientX: number; clientY: number }): Pt => {
    const r = stage.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const viewStart = (a0: Pt, b0?: Pt): Gest => ({ kind: "view", z0: zoom.current.z, x0: zoom.current.x, y0: zoom.current.y, a0, b0 });
  function select(o: Obj | null) {
    setSel(o?.id ?? null);
    if (o && tabOf(o) !== toolRef.current) { toolRef.current = tabOf(o); setToolState(tabOf(o)); }
  }
  /** Turns on screen to the nearest quarter when it's within a few degrees. */
  function snapRot(M: Mat, o: Obj): [Obj, boolean] {
    const sr = screenRot(M, o), d = Math.round(sr / HALF) * HALF - sr;
    return Math.abs(d) < SNAP ? [{ ...o, rot: o.rot + (mirroredView(M) ? -d : d) }, true] : [o, false];
  }

  function down(e: RPE<HTMLDivElement>) {
    if (!ready || busy) return;
    e.preventDefault();
    const p = ptOf(e);
    P.current.set(e.pointerId, p);
    e.currentTarget.setPointerCapture(e.pointerId);
    const s = S(), tl = toolRef.current;
    if (picking) { G.current = { kind: "pick" }; sample(p); return; }
    if (P.current.size === 2) return second();
    if (P.current.size > 2) return;
    if (e.button === 1 || space.current) { if (tl !== "crop") G.current = viewStart(p); return; }
    if (e.button !== 0) return;
    if (tl === "crop") {
      const h = cropHandle(p), k = scaleOf(cropView(s));
      if (h) { frozen.current = cropView(s); G.current = { kind: "cropHandle", ...h, c0: s.crop, p0: p, k }; }
      else G.current = { kind: "cropPan", c0: s.crop, p0: p, k };
      invalidate();
      return;
    }
    if (tl === "draw" || tl === "blur") {
      const M = shown.current, [x, y] = toSource(p), tool: Stroke["tool"] = tl === "blur" ? prefs.blur : prefs.pen;
      const st: Stroke = { tool, color: prefs.color.draw, size: brushPx(tl === "blur" ? prefs.size.blur : prefs.size[prefs.pen]) / scaleOf(M),
        pts: [x, y, e.pressure || 0.5], ...(e.pointerType === "pen" && { pressure: true }) };
      G.current = { kind: "stroke", id: e.pointerId, st, t0: performance.now(), last: p };
      invalidate();
      return;
    }
    if (tl === "adjust") { comparing.current = true; G.current = { kind: "compare" }; invalidate(); return; }
    // text, stickers, shapes: the objects
    const o = objOf(selRef.current), k = o && knobAt(o, p);
    if (o && k) { hist.current.before = s; G.current = { kind: "knob", knob: k, o0: o, p0: p, snap: false }; invalidate(); return; }
    const hit = objAt(p);
    if (hit) {
      hist.current.before = s;
      G.current = { kind: "move", o0: hit, p0: p, moved: false, wasSel: selRef.current === hit.id, hot: false, snap: "" };
      select(hit);
      return;
    }
    const had = selRef.current != null; // a tap beside the selection just drops it
    if (had) select(null);
    G.current = tl === "shapes" ? { kind: "newShape", a: p, id: ids.current++, made: false } : tl === "text" && !had ? { kind: "tap", p0: p, moved: false } : { kind: "none" };
  }

  /** A second finger: a stroke just begun becomes a pinch of the view; a dragged object, a pinch of it. */
  function second() {
    const [a, b] = [...P.current.values()], g = G.current, tl = toolRef.current;
    if (g?.kind === "stroke") {
      if (g.st.pts.length > 24 && performance.now() - g.t0 > 300) return; // well into a line: a resting palm, keep drawing
      G.current = null;
    }
    if (g?.kind === "move" || g?.kind === "knob") {
      const o = objOf(g.o0.id);
      if (o) { G.current = { kind: "pinch", o0: o, a0: a, b0: b, snap: false }; setDragging(false); return; }
    }
    if (g?.kind === "cropHandle") return;
    if (g?.kind === "newShape" && g.made) { cancelLive(); setSel(null); }
    if (tl === "crop") { G.current = { kind: "cropPinch", c0: S().crop, a0: a, b0: b, k: scaleOf(cropView(S())) }; return; }
    G.current = viewStart(a, b);
    comparing.current = false;
    invalidate();
  }

  function move(e: RPE<HTMLDivElement>) {
    if (!P.current.has(e.pointerId)) return;
    const p = ptOf(e);
    P.current.set(e.pointerId, p);
    const g = G.current, s = S(), M = shown.current;
    if (!g || (g.kind === "stroke" && e.pointerId !== g.id)) return;
    const { W, H } = dims.current, { ow, oh } = turned(s, W, H);
    switch (g.kind) {
      case "pick": sample(p); return;
      case "stroke": {
        const evs = e.nativeEvent.getCoalescedEvents?.() ?? [];
        for (const ev of evs.length ? evs : [e.nativeEvent]) {
          const q = ptOf(ev);
          if (dist(q, g.last) < 1.5) continue;
          g.last = q;
          const [x, y] = toSource(q);
          g.st = { ...g.st, pts: [...g.st.pts, x, y, ev.pressure || 0.5] };
        }
        invalidate();
        return;
      }
      case "view": {
        const [a, b] = [...P.current.values()], { w, h } = size.current, c: Pt = [w / 2, h / 2];
        const m0 = g.b0 ? mid(g.a0, g.b0) : g.a0, m1 = g.b0 && b ? mid(a, b) : a;
        const z = g.b0 && b ? clamp(g.z0 * dist(a, b) / (dist(g.a0, g.b0) || 1), 1, 8) : g.z0;
        // the point under the fingers stays under them
        const bx = c[0] + (m0[0] - c[0] - g.x0) / g.z0, by = c[1] + (m0[1] - c[1] - g.y0) / g.z0;
        const mx = ((z - 1) * w) / 2, my = ((z - 1) * h) / 2;
        zoom.current = { z, x: clamp(m1[0] - c[0] - z * (bx - c[0]), -mx, mx), y: clamp(m1[1] - c[1] - z * (by - c[1]), -my, my) };
        invalidate();
        return;
      }
      case "cropHandle": {
        const dx = (p[0] - g.p0[0]) / g.k, dy = (p[1] - g.p0[1]) / g.k, c0 = g.c0, min = 64 / g.k;
        const fits = (c: Rect) => cropFits(c, ow, oh, s.angle);
        let L = c0.x, T = c0.y, Rt = c0.x + c0.w, B = c0.y + c0.h;
        if (g.hx < 0) L = Math.min(L + dx, Rt - min);
        if (g.hx > 0) Rt = Math.max(Rt + dx, L + min);
        if (g.hy < 0) T = Math.min(T + dy, B - min);
        if (g.hy > 0) B = Math.max(B + dy, T + min);
        const r = avatar ? 1 : aspectRatio(s.aspect, ow, oh);
        let crop: Rect;
        if (r) { // the ratio holds, anchored on the opposite side
          let w = Rt - L, h = B - T;
          if (g.hx && g.hy) { if (w / h > r) h = w / r; else w = h * r; } else if (g.hx) h = w / r; else w = h * r;
          const ax = g.hx > 0 ? c0.x : g.hx < 0 ? c0.x + c0.w : c0.x + c0.w / 2, ay = g.hy > 0 ? c0.y : g.hy < 0 ? c0.y + c0.h : c0.y + c0.h / 2;
          crop = limitCrop(c0, { x: g.hx > 0 ? ax : g.hx < 0 ? ax - w : ax - w / 2, y: g.hy > 0 ? ay : g.hy < 0 ? ay - h : ay - h / 2, w, h }, fits);
        } else { // each axis on its own, so a corner slides along the edge it meets
          const c1 = limitCrop(c0, { ...c0, x: L, w: Rt - L }, fits);
          crop = limitCrop(c1, { ...c1, y: T, h: B - T }, fits);
        }
        live({ ...s, crop }, true);
        return;
      }
      case "cropPan": {
        const c0 = g.c0;
        live({ ...s, crop: fitCrop({ ...c0, x: c0.x - (p[0] - g.p0[0]) / g.k, y: c0.y - (p[1] - g.p0[1]) / g.k }, ow, oh, s.angle) }, true);
        return;
      }
      case "cropPinch": {
        const [a, b] = [...P.current.values()];
        if (!b) return;
        const f = clamp(dist(g.a0, g.b0) / (dist(a, b) || 1), 64 / g.k / Math.min(g.c0.w, g.c0.h), 50);
        live({ ...s, crop: pinchCrop(g.c0, g.k, f, mid(g.a0, g.b0), mid(a, b), [size.current.w / 2, size.current.h / 2], ow, oh, s.angle) }, true);
        return;
      }
      case "tap": if (dist(p, g.p0) > 6) g.moved = true; return;
      case "compare": case "none": return;
      case "newShape": {
        if (!g.made && dist(p, g.a) < 6) return;
        const sg = scaleOf(M), [x, y] = toSource(mid(g.a, p)), line = prefs.shape === "line" || prefs.shape === "arrow";
        const o: ShapeObj = {
          id: g.id, kind: "shape", shape: prefs.shape, color: prefs.color.shape, width: brushPx(prefs.size.shape) / sg, fill: prefs.fill && !line,
          x, y, scale: 1, ...upright(M, line ? Math.atan2(p[1] - g.a[1], p[0] - g.a[0]) : 0),
          w: line ? dist(g.a, p) / sg : Math.abs(p[0] - g.a[0]) / sg, h: line ? 0 : Math.abs(p[1] - g.a[1]) / sg,
        };
        const base = hist.current.before ?? s;
        if (!g.made) { g.made = true; setSel(o.id); }
        live({ ...base, objects: [...base.objects.filter((x) => x.id !== o.id), o] }, true);
        return;
      }
      case "move": {
        if (!g.moved && dist(p, g.p0) > 4) { g.moved = true; setDragging(true); }
        if (!g.moved) return;
        const [cx, cy] = apply(M, g.o0.x, g.o0.y), toScreen = mul(M, inv(orient(s, W, H)));
        const [fx, fy] = apply(toScreen, s.crop.x + s.crop.w / 2, s.crop.y + s.crop.h / 2);
        let nx = cx + p[0] - g.p0[0], ny = cy + p[1] - g.p0[1], snap = "";
        if (Math.abs(nx - fx) < 8) { nx = fx; snap += "x"; }
        if (Math.abs(ny - fy) < 8) { ny = fy; snap += "y"; }
        if (snap && snap !== g.snap) vibrate();
        g.snap = snap;
        const [x, y] = apply(inv(M), nx, ny), b = bin.current?.getBoundingClientRect();
        const hot = !!b && Math.hypot(e.clientX - (b.left + b.width / 2), e.clientY - (b.top + b.height / 2)) < 48;
        if (hot !== g.hot) { g.hot = hot; bin.current?.classList.toggle("hot", hot); if (hot) vibrate(15); }
        live(withObj({ ...g.o0, x, y, ...(hot && { scale: g.o0.scale * 0.6 }) }), true);
        return;
      }
      case "knob": {
        const o0 = g.o0;
        let o: Obj = o0;
        if (g.knob === "scale") {
          const [cx, cy] = apply(M, o0.x, o0.y), v0: Pt = [g.p0[0] - cx, g.p0[1] - cy], v1: Pt = [p[0] - cx, p[1] - cy];
          const d = Math.atan2(v1[1], v1[0]) - Math.atan2(v0[1], v0[0]);
          let snapped: boolean;
          [o, snapped] = snapRot(M, { ...o0, scale: Math.max(0.05, o0.scale * Math.hypot(...v1) / (Math.hypot(...v0) || 1)), rot: o0.rot + (mirroredView(M) ? -d : d) });
          if (snapped && !g.snap) vibrate();
          g.snap = snapped;
        } else if (o0.kind === "shape" && (g.knob === "end0" || g.knob === "end1")) {
          const om = objMatrix(o0), fixed = apply(om, g.knob === "end1" ? -o0.w / 2 : o0.w / 2, 0), moved = toSource(p);
          const [e0, e1] = g.knob === "end1" ? [fixed, moved] : [moved, fixed], ang = Math.atan2(e1[1] - e0[1], e1[0] - e0[0]);
          o = { ...o0, x: (e0[0] + e1[0]) / 2, y: (e0[1] + e1[1]) / 2, w: Math.hypot(e1[0] - e0[0], e1[1] - e0[1]) / o0.scale, rot: o0.mirror ? ang - Math.PI : ang };
        } else if (o0.kind === "shape") { // stretch one side; the opposite one stays
          const lm = inv(mul(M, objMatrix(o0))), [lx0, ly0] = apply(lm, ...g.p0), [lx, ly] = apply(lm, ...p), min = 12 / scaleOf(mul(M, objMatrix(o0)));
          const sx = g.knob === "r" ? 1 : g.knob === "l" ? -1 : 0, sy = g.knob === "b" ? 1 : g.knob === "t" ? -1 : 0;
          const w = Math.max(min, o0.w + sx * (lx - lx0)), h = Math.max(min, o0.h + sy * (ly - ly0));
          const [x, y] = apply(objMatrix(o0), sx * (w - o0.w) / 2, sy * (h - o0.h) / 2);
          o = { ...o0, w, h, x, y };
        }
        live(withObj(o), true);
        return;
      }
      case "pinch": {
        const [a, b] = [...P.current.values()];
        if (!b) return;
        const o0 = g.o0, [cx, cy] = apply(M, o0.x, o0.y), m0 = mid(g.a0, g.b0), m1 = mid(a, b);
        const d = Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.atan2(g.b0[1] - g.a0[1], g.b0[0] - g.a0[0]);
        const [x, y] = apply(inv(M), cx + m1[0] - m0[0], cy + m1[1] - m0[1]);
        const [o, snapped] = snapRot(M, { ...o0, x, y, scale: Math.max(0.05, o0.scale * dist(a, b) / (dist(g.a0, g.b0) || 1)), rot: o0.rot + (mirroredView(M) ? -d : d) });
        if (snapped && !g.snap) vibrate();
        g.snap = snapped;
        live(withObj(o), true);
        return;
      }
    }
  }

  function up(e: RPE<HTMLDivElement>) {
    if (!P.current.delete(e.pointerId)) return;
    const g = G.current;
    if (g?.kind === "stroke" && e.pointerId !== g.id) return; // a resting palm lifted
    G.current = P.current.size ? { kind: "none" } : null; // a pinch ends with its first finger
    if (g) end(g, ptOf(e));
    invalidate();
    bump();
  }
  function end(g: Gest, p: Pt) {
    const s = S();
    switch (g.kind) {
      case "pick": { const c = sample(p); if (c) { picking?.(c); remember(c); } setPicking(null); break; }
      case "stroke": commit({ ...s, strokes: [...s.strokes, g.st] }); break;
      case "cropHandle": animate(); frozen.current = null; commit(); break;
      case "cropPan": case "cropPinch": case "knob": case "pinch": commit(); break;
      case "compare": comparing.current = false; break;
      case "tap": if (!g.moved) newText(g.p0); break;
      case "newShape": if (g.made) commit(); break;
      case "move": {
        setDragging(false);
        if (g.hot) { commit(without(g.o0.id, hist.current.before ?? s)); setSel(null); vibrate(20); break; }
        commit();
        if (!g.moved && g.wasSel && g.o0.kind === "text") setTextEdit({ o: g.o0, isNew: false });
        break;
      }
    }
  }

  function onWheel(e: WheelEvent) {
    if (!ready) return;
    const p = ptOf(e), f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), s = S();
    if (toolRef.current === "crop") {
      const { ow, oh } = turned(s, dims.current.W, dims.current.H), k = scaleOf(cropView(s));
      live({ ...s, crop: pinchCrop(s.crop, k, clamp(1 / f, 64 / k / Math.min(s.crop.w, s.crop.h), 50), p, p, [size.current.w / 2, size.current.h / 2], ow, oh, s.angle) }, true);
      clearTimeout(wheelEnd.current);
      wheelEnd.current = window.setTimeout(() => commit(), 300);
      return;
    }
    const { w, h } = size.current, c: Pt = [w / 2, h / 2], z0 = zoom.current, z = clamp(z0.z * f, 1, 8);
    const bx = c[0] + (p[0] - c[0] - z0.x) / z0.z, by = c[1] + (p[1] - c[1] - z0.y) / z0.z, mx = ((z - 1) * w) / 2, my = ((z - 1) * h) / 2;
    zoom.current = { z, x: clamp(p[0] - c[0] - z * (bx - c[0]), -mx, mx), y: clamp(p[1] - c[1] - z * (by - c[1]), -my, my) };
    invalidate();
  }
  wheelRef.current = onWheel;

  /** The eyedropper: the colour under p on screen, shown in the loupe. */
  function sample(p: Pt) {
    const c = cv.current, l = loupe.current;
    if (!c) return null;
    const dpr = devicePixelRatio || 1, x = Math.round(p[0] * dpr), y = Math.round(p[1] * dpr);
    const [r, g, b] = c.getContext("2d")!.getImageData(clamp(x, 0, c.width - 1), clamp(y, 0, c.height - 1), 1, 1).data;
    const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    if (l) {
      const lg = l.getContext("2d")!, n = 11;
      l.width = l.height = Math.round(96 * dpr);
      lg.imageSmoothingEnabled = false;
      lg.drawImage(c, x - (n >> 1), y - (n >> 1), n, n, 0, 0, l.width, l.height);
      const wrap = l.parentElement!;
      wrap.style.transform = `translate(${p[0] - 48}px, ${p[1] - 140}px)`;
      wrap.style.borderColor = hex;
      wrap.hidden = false;
    }
    return hex;
  }
  function remember(c: string) { setPrefs((p) => ({ ...p, recent: [c, ...p.recent.filter((x) => x !== c)].slice(0, 8) })); }

  // ---------- actions ----------
  function setTool(tl: Tool) {
    if (tl === toolRef.current) { if (tl === "sticker") setPanel(true); return; }
    if (tl === "crop" || toolRef.current === "crop") { animate(); zoom.current = { z: 1, x: 0, y: 0 }; }
    const o = objOf(selRef.current);
    if (o && tabOf(o) !== tl) setSel(null);
    toolRef.current = tl;
    setToolState(tl);
    if (tl === "sticker") setPanel(true);
    if (tl === "text" && !S().objects.some((x) => x.kind === "text")) newText();
    invalidate();
  }
  /** Where a new object goes: the middle of the stage, stepped aside from ones already there, so it's seen arriving. */
  function spot(): Pt {
    const { w, h } = size.current, M = shown.current;
    let p: Pt = [w / 2, h / 2];
    while (S().objects.some((o) => dist(apply(M, o.x, o.y), p) < 12) && p[1] < h - 40) p = [p[0] + 28, p[1] + 28];
    return p;
  }
  function newText(p?: Pt) {
    const M = shown.current, [x, y] = toSource(p ?? spot());
    const o: TextObj = { id: ids.current++, kind: "text", text: "", font: prefs.font, style: prefs.style, align: prefs.align, color: prefs.color.text,
      size: 30 / scaleOf(M), x, y, scale: 1, ...upright(M) };
    setTextEdit({ o, isNew: true });
  }
  function finishText(o: TextObj) {
    const te = textEdit;
    setTextEdit(null);
    if (!te) return;
    const s = S();
    setPrefs((p) => ({ ...p, font: o.font, style: o.style, align: o.align, color: { ...p.color, text: o.color } }));
    if (!o.text.trim()) { if (!te.isNew) commit(without(o.id)); setSel(null); return; }
    commit(te.isNew ? { ...s, objects: [...s.objects, o] } : withObj(o));
    select(o);
  }
  async function addSticker(src: string) {
    setPanel(false);
    const img = image(src);
    await img.decode().catch(() => {});
    const M = shown.current, k = 128 / scaleOf(M) / Math.max(img.naturalWidth || 1, img.naturalHeight || 1), [x, y] = toSource(spot());
    const o: Obj = { id: ids.current++, kind: "sticker", src, w: (img.naturalWidth || 1) * k, h: (img.naturalHeight || 1) * k, x, y, scale: 1, ...upright(M) };
    const s = S();
    commit({ ...s, objects: [...s.objects, o] });
    select(o);
  }
  function addCustom(e: Emote) {
    const u = mediaUrl({ url: e.img.url });
    if (u) void u.then(addSticker, () => toast(t("edit.cantOpen")));
  }
  function duplicate(o: Obj) {
    const M = shown.current, [x0, y0] = apply(M, o.x, o.y), [x, y] = apply(inv(M), x0 + 24, y0 + 24);
    const c = { ...o, id: ids.current++, x, y }, s = S();
    commit({ ...s, objects: [...s.objects, c] });
    select(c);
  }
  function toFront(o: Obj) { const s = without(o.id); commit({ ...s, objects: [...s.objects, o] }); }
  function remove(o: Obj) { commit(without(o.id)); setSel(null); }

  /** A style change also applies to the selected object of that kind. */
  function restyle(kind: Obj["kind"], p: (x: Prefs) => Prefs, o: (x: Obj) => Obj) {
    setPrefs(p);
    const cur = objOf(selRef.current);
    if (cur?.kind === kind) commit(withObj(o(cur)));
  }
  function moreColors(color: string, applyColor: (c: string) => void) { setSheet({ color, apply: applyColor }); }

  // crop
  const turn = () => { animate(); commit(turnLeft(S())); };
  const flip = () => { animate(); commit(mirror(S())); };
  function aspect(a: Aspect) {
    const s = S(), { ow, oh } = turned(s, dims.current.W, dims.current.H), r = aspectRatio(a, ow, oh);
    animate();
    commit({ ...s, aspect: a, crop: r ? cropToRatio(s.crop, r, ow, oh, s.angle) : s.crop });
  }
  function resetCrop() {
    const s = S(), { W, H } = dims.current, b = blank(W, H);
    animate();
    commit({ ...s, rot: 0, flip: false, angle: 0, aspect: avatar ? "1:1" : "free", crop: avatar ? cropToRatio(b.crop, 1, W, H, 0) : b.crop });
  }

  async function finish() {
    if (busy || !ready) return;
    const s = S(), { W, H } = dims.current;
    if (!avatar && s === hist.current.first) return close(file);
    if (!avatar && isBlank(s, W, H)) return close(original);
    setBusy(true);
    try {
      const out = await exportEdit(original, s, avatar ? 1024 : undefined);
      edits.set(out, { original, state: s });
      close(out);
    } catch {
      toast(t("edit.saveFailed"));
      setBusy(false);
    }
  }
  async function cancel() {
    if (ready && S() !== hist.current.first && !(await confirmDialog(t("edit.discardQ"), { danger: true, ok: t("edit.discard") }))) return;
    close(null);
  }
  function close(f: File | null) {
    setClosing(true);
    setTimeout(() => done(f), reducedMotion() ? 0 : 160);
  }
  /** Back and Esc close what's on top first: the eyedropper, the selection, then the editor. */
  function back() {
    if (picking) return setPicking(null);
    if (selRef.current != null) return setSel(null);
    void cancel();
  }
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => pushBack(() => { backRef.current(); }), []);
  useEffect(() => (panel ? pushBack(() => { setPanel(false); }) : undefined), [panel]);

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (textEdit || sheet || panel || busy) return;
    if (e.target !== document.body && !root.current?.contains(e.target as Node)) return; // a dialog over us
    const typing = !!(e.target as HTMLElement).closest?.("input, textarea"), mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === "KeyZ") { e.preventDefault(); step(!e.shiftKey); }
    else if (mod && e.code === "KeyY") { e.preventDefault(); step(false); }
    else if ((e.key === "Delete" || e.key === "Backspace") && !typing && objOf(sel)) { e.preventDefault(); remove(objOf(sel)!); }
    else if (e.key === "Escape") { e.preventDefault(); back(); }
    else if (e.key === "Enter" && !typing && !mod && (e.target as HTMLElement).tagName !== "BUTTON") { e.preventDefault(); void finish(); }
    else if (e.code === "Space" && !typing) { e.preventDefault(); space.current = true; }
  };
  useEffect(() => {
    const kd = (e: KeyboardEvent) => keys.current(e), ku = (e: KeyboardEvent) => { if (e.code === "Space") space.current = false; };
    addEventListener("keydown", kd);
    addEventListener("keyup", ku);
    return () => { removeEventListener("keydown", kd); removeEventListener("keyup", ku); };
  }, []);

  // ---------- the strip above the tabs ----------
  const s = S(), selected = objOf(sel), { ow, oh } = turned(s, W, H);
  const px = scaleOf(shown.current);
  const h0 = hist.current;
  /** ltr: a −…+ scale reads left to right like a number line, in Persian too; sizes run from the page's start. */
  const slider = (value: number, onChange: (v: number) => void, label: string, o: { min?: number; max?: number; zero?: number; onEnd?: () => void; reset?: () => void; ltr?: boolean } = {}) => {
    const min = o.min ?? 1, max = o.max ?? 100, pc = (v: number) => ((v - min) / (max - min)) * 100, z = o.zero ?? min, back = rtl && !o.ltr;
    return (
      <input type="range" dir={back ? "rtl" : "ltr"} className="ie-range" min={min} max={max} value={value} aria-label={label} title={label}
        style={{ "--a": Math.min(pc(z), pc(value)) + "%", "--b": Math.max(pc(z), pc(value)) + "%", "--to": back ? "to left" : "to right" } as CSSProperties}
        onChange={(e) => onChange(+e.target.value)} onPointerUp={o.onEnd} onKeyUp={o.onEnd} onBlur={o.onEnd} onDoubleClick={o.reset} />
    );
  };
  const dot = (v: number, color: string) => <span className="ie-dot" style={{ width: Math.min(40, brushPx(v)), height: Math.min(40, brushPx(v)), background: color }} aria-hidden />;
  const kinds = <K extends string>(list: [K, IconName, Key][], on: K, pick: (k: K) => void) => list.map(([k, icon, label]) => (
    <button key={k} className={"icon-btn" + (on === k ? " on" : "")} aria-pressed={on === k} aria-label={t(label)} title={t(label)} onClick={() => pick(k)}><Icon name={icon} /></button>
  ));
  const colors = (value: string, onChange: (c: string) => void, disabled = false) => (
    <Colors value={value} onChange={onChange} onMore={() => moreColors(value, onChange)} disabled={disabled} />
  );
  type Look = Pick<TextObj, "font" | "style" | "align">;
  const textTools = (o: Look & { text?: string }, set: (p: Partial<Look>) => void) => {
    const dir = textDir(o.text || (lang === "fa" ? "ا" : "a"));
    const alignIcon: IconName = o.align === "center" ? "alignCenter" : (o.align === "start") === (dir === "ltr") ? "alignLeft" : "alignRight";
    const styleName = t(STYLES.find(([k]) => k === o.style)![1]);
    return (
      <>
        <button className="ie-font" style={{ font: FONTS[o.font].replace("{s}", "17") }} aria-label={t("edit.font")} title={t("edit.font")} onClick={() => set({ font: next(FONT_ORDER, o.font) })}>{lang === "fa" ? "اب" : "Aa"}</button>
        <button className={"ie-style " + o.style} aria-label={`${t("edit.style")}: ${styleName}`} title={styleName} onClick={() => set({ style: next(STYLES.map(([k]) => k), o.style) })}><span>{lang === "fa" ? "ا" : "A"}</span></button>
        <button className="icon-btn" aria-label={t("edit.align")} title={t("edit.align")} onClick={() => set({ align: next(ALIGNS, o.align) })}><Icon name={alignIcon} /></button>
      </>
    );
  };

  let options;
  if (tool === "crop") {
    options = (
      <>
        <Dial angle={s.angle} label={t("edit.straighten")}
          onStart={() => { hist.current.before = S(); setStraightening(true); }}
          onChange={(a) => { const b = hist.current.before ?? S(); live({ ...S(), angle: a, crop: fitCrop(b.crop, ow, oh, a) }); }}
          onEnd={() => { setStraightening(false); commit(); }} />
        <div className="ie-row">
          <button className="icon-btn" aria-label={t("edit.rotate")} title={t("edit.rotate")} onClick={turn}><Icon name="rotate" /></button>
          <button className="icon-btn" aria-label={t("edit.mirror")} title={t("edit.mirror")} onClick={flip}><Icon name="mirror" /></button>
          {!avatar && (
            <div className="ie-chips" role="radiogroup" aria-label={t("edit.aspect")}>
              {ASPECTS.map((a) => (
                <button key={a} role="radio" aria-checked={s.aspect === a} className={"ie-chip" + (s.aspect === a ? " on" : "")} onClick={() => aspect(a)}>
                  {a === "free" ? t("edit.free") : a === "orig" ? t("edit.original") : a === "1:1" ? t("edit.square") : <bdi dir="ltr">{a.split(":").map(Number).map(num).join(":")}</bdi>}
                </button>
              ))}
            </div>
          )}
          <span className="ie-grow" />
          <button className="ie-chip" onClick={resetCrop}>{t("edit.reset")}</button>
        </div>
      </>
    );
  } else if (tool === "draw") {
    options = (
      <>
        <div className="ie-row">
          {kinds(PENS, prefs.pen, (k) => setPrefs((p) => ({ ...p, pen: k })))}
          {dot(prefs.size[prefs.pen], prefs.pen === "eraser" ? "#fff" : prefs.color.draw)}
          {slider(prefs.size[prefs.pen], (v) => setPrefs((p) => ({ ...p, size: { ...p.size, [p.pen]: v } })), t("edit.size"))}
        </div>
        {colors(prefs.color.draw, (c) => setPrefs((p) => ({ ...p, color: { ...p.color, draw: c }, pen: p.pen === "eraser" ? "pen" : p.pen })), prefs.pen === "eraser")}
      </>
    );
  } else if (tool === "blur") {
    options = (
      <div className="ie-row">
        {kinds([["blur", "blur", "edit.blurBrush"], ["pixelate", "pixel", "edit.pixelate"]], prefs.blur, (k) => setPrefs((p) => ({ ...p, blur: k })))}
        {dot(prefs.size.blur, "rgba(255,255,255,0.6)")}
        {slider(prefs.size.blur, (v) => setPrefs((p) => ({ ...p, size: { ...p.size, blur: v } })), t("edit.size"))}
      </div>
    );
  } else if (tool === "text") {
    const o = selected?.kind === "text" ? selected : null, cur = o ?? { font: prefs.font, style: prefs.style, align: prefs.align, text: "" };
    options = (
      <>
        <div className="ie-row">
          <button className="ie-chip ie-add" onClick={() => newText()}><Icon name="plus" size={18} /> {t("edit.addText")}</button>
          <span className="ie-grow" />
          {textTools(cur, (pt) => restyle("text", (p) => ({ ...p, ...pt }), (x) => ({ ...x, ...pt }) as Obj))}
        </div>
        {colors(o?.color ?? prefs.color.text, (c) => restyle("text", (p) => ({ ...p, color: { ...p.color, text: c } }), (x) => ({ ...x, color: c }) as Obj))}
      </>
    );
  } else if (tool === "sticker") {
    options = (
      <div className="ie-row">
        <button className="ie-chip ie-add" onClick={() => setPanel(true)}><Icon name="plus" size={18} /> {t("edit.addSticker")}</button>
        <span className="ie-grow" />
        {selected?.kind === "sticker" && <button className="icon-btn" aria-label={t("edit.mirror")} title={t("edit.mirror")} onClick={() => commit(withObj({ ...selected, mirror: !selected.mirror }))}><Icon name="mirror" /></button>}
      </div>
    );
  } else if (tool === "shapes") {
    const o = selected?.kind === "shape" ? selected : null, kind = o?.shape ?? prefs.shape, line = kind === "line" || kind === "arrow";
    const width = o ? clamp(Math.round(((o.width * o.scale * px) - 2) / 0.38), 1, 100) : prefs.size.shape;
    options = (
      <>
        <div className="ie-row">
          {kinds(SHAPES, kind, (k) => restyle("shape", (p) => ({ ...p, shape: k }),
            (x) => ((k === "line" || k === "arrow") === open(x) ? { ...x, shape: k } as Obj : x)))}
          <button className={"ie-chip" + ((o ? o.fill : prefs.fill) && !line ? " on" : "")} disabled={line} aria-pressed={(o ? o.fill : prefs.fill) && !line}
            onClick={() => restyle("shape", (p) => ({ ...p, fill: !(o ? o.fill : p.fill) }), (x) => ({ ...x, fill: !(x as ShapeObj).fill }) as Obj)}>{t("edit.fill")}</button>
          {dot(width, o?.color ?? prefs.color.shape)}
          {slider(width, (v) => {
            setPrefs((p) => ({ ...p, size: { ...p.size, shape: v } }));
            if (o) live(withObj({ ...o, width: brushPx(v) / px / o.scale }), true);
          }, t("edit.size"), { onEnd: () => { if (hist.current.before) commit(); } })}
        </div>
        {colors(o?.color ?? prefs.color.shape, (c) => restyle("shape", (p) => ({ ...p, color: { ...p.color, shape: c } }), (x) => ({ ...x, color: c }) as Obj))}
      </>
    );
  } else {
    const v = s.adjust[adj] ?? 0, uni = UNIPOLAR.has(adj);
    const setV = (n: number) => { const a = { ...S().adjust }; if (n) a[adj] = n; else delete a[adj]; live({ ...S(), adjust: a }); };
    options = (
      <>
        <div className="ie-row">
          <span className="ie-value"><bdi dir="ltr">{uni ? num(v) : signed(v)}</bdi></span>
          {slider(v, setV, t(`edit.${adj}` as Key), { min: uni ? 0 : -100, max: 100, zero: 0, ltr: true, onEnd: () => { if (hist.current.before) commit(); }, reset: () => { setV(0); commit(); } })}
        </div>
        <div className="ie-chips" role="radiogroup" aria-label={t("edit.adjust")}>
          {ADJUST.filter((k) => k === "vignette" || glMax()).map((k) => (
            <button key={k} role="radio" aria-checked={adj === k} className={"ie-chip" + (adj === k ? " on" : "") + (s.adjust[k] ? " set" : "")} onClick={() => setAdj(k)}>{t(`edit.${k}` as Key)}</button>
          ))}
        </div>
        <small className="ie-hint">{t("edit.compareHint")}</small>
      </>
    );
  }

  return (
    <div ref={root} className={"img-editor" + (closing ? " closing" : "") + (textEdit ? " texting" : "")} role="dialog" aria-modal="true" aria-label={t("edit.title")}>
      <div className="ie-top">
        <button className="icon-btn" aria-label={t("common.cancel")} title={t("common.cancel")} onClick={() => void cancel()}><Icon name="close" /></button>
        <div className="ie-history">
          <button className="icon-btn" aria-label={t("edit.undo")} title={t("edit.undo")} disabled={!h0.past.length && !h0.before} onClick={() => step(true)}><Icon name="undo" /></button>
          <button className="icon-btn" aria-label={t("edit.redo")} title={t("edit.redo")} disabled={!h0.future.length} onClick={() => step(false)}><Icon name="redo" /></button>
        </div>
        <button className="ie-done" aria-label={t("edit.done")} title={t("edit.done")} disabled={!ready || busy} onClick={() => void finish()}>
          {busy ? <span className="spinner inline" /> : <Icon name="check" />}
        </button>
      </div>
      <div ref={stage} className={"ie-stage" + (tool === "draw" || tool === "blur" ? " ink" : "")} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onContextMenu={(e) => e.preventDefault()}>
        <canvas ref={cv} role="img" aria-label={t("edit.title")} />
        {!ready && <span className="spinner" />}
        <div ref={bar} className="ie-bar hidden" onPointerDown={(e) => e.stopPropagation()}>
          {selected?.kind === "text" && <button className="icon-btn" aria-label={t("edit.editText")} title={t("edit.editText")} onClick={() => setTextEdit({ o: selected, isNew: false })}><Icon name="edit" /></button>}
          {selected && <button className="icon-btn" aria-label={t("edit.duplicate")} title={t("edit.duplicate")} onClick={() => duplicate(selected)}><Icon name="copy" /></button>}
          {selected && <button className="icon-btn" aria-label={t("edit.toFront")} title={t("edit.toFront")} onClick={() => toFront(selected)}><Icon name="front" /></button>}
          {selected && <button className="icon-btn" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => remove(selected)}><Icon name="trash" /></button>}
        </div>
        {dragging && <div ref={bin} className="ie-bin" aria-label={t("edit.dropToDelete")}><Icon name="trash" size={24} /></div>}
        {picking && <div className="ie-loupe" hidden><canvas ref={loupe} /></div>}
        {picking && <div className="ie-pill">{t("edit.pickHint")}</div>}
      </div>
      <div className="ie-options" key={tool}>{ready && options}</div>
      <div className="ie-tabs" role="tablist" aria-label={t("edit.title")}>
        {TABS.map(([k, icon, label]) => (
          <button key={k} role="tab" aria-selected={tool === k} className={"ie-tab" + (tool === k ? " on" : "")} onClick={() => setTool(k)} disabled={!ready}>
            <Icon name={icon} size={22} /><span>{t(label)}</span>
          </button>
        ))}
      </div>
      {panel && (
        <div className="ie-emoji">
          <EmojiPanel room={room} onClose={() => setPanel(false)} onEmoji={(u, custom) => (custom ? addCustom(custom) : void addSticker(emojiUrl(u, true)))}
            stickers={{ onPick: addCustom }} />
        </div>
      )}
      {textEdit && <TextOverlay o={textEdit.o} px={px} onDone={finishText} tools={textTools} onMore={moreColors} />}
      {sheet && (
        <ColorSheet color={sheet.color} recent={prefs.recent} onClose={() => setSheet(null)}
          onPick={(c) => { sheet.apply(c); remember(c); setSheet(null); }}
          onDropper={textEdit ? undefined : () => { const a = sheet.apply; setSheet(null); setPicking(() => a); }} />
      )}
    </div>
  );
}

/** The crop zoomed by f (f < 1: in) about the point under a0, which moves to a1. k: screen px per canvas unit before;
 *  c: the frame's centre on screen (the crop stays centred in it). */
function pinchCrop(c0: Rect, k: number, f: number, a0: Pt, a1: Pt, c: Pt, ow: number, oh: number, angle: number): Rect {
  const w = c0.w * f, h = c0.h * f;
  const x = c0.x + c0.w / 2 + (a0[0] - c[0]) / k - ((a1[0] - c[0]) * f) / k, y = c0.y + c0.h / 2 + (a0[1] - c[1]) / k - ((a1[1] - c[1]) * f) / k;
  return fitCrop({ x: x - w / 2, y: y - h / 2, w, h }, ow, oh, angle);
}

function Colors({ value, onChange, onMore, disabled }: { value: string; onChange: (c: string) => void; onMore: () => void; disabled?: boolean }) {
  const custom = !SWATCHES.includes(value);
  return (
    <div className={"ie-colors" + (disabled ? " off" : "")} role="radiogroup" aria-label={t("edit.color")}>
      {SWATCHES.map((c) => (
        <button key={c} role="radio" aria-checked={!disabled && c === value} className={"ie-swatch" + (!disabled && c === value ? " on" : "")} style={{ background: c }} aria-label={c} onClick={() => onChange(c)} />
      ))}
      <button className={"ie-swatch ie-more" + (!disabled && custom ? " on" : "")} style={custom ? ({ "--c": value } as CSSProperties) : undefined}
        aria-label={t("edit.moreColors")} title={t("edit.moreColors")} onClick={onMore} />
    </div>
  );
}

/** The straighten ruler: dragging slides it under the needle, a degree per 6px; 0 catches. */
function Dial({ angle, label, onStart, onChange, onEnd }: { angle: number; label: string; onStart: () => void; onChange: (a: number) => void; onEnd: () => void }) {
  const g = useRef<{ x: number; a: number; zero: boolean } | null>(null);
  const set = (a: number) => {
    const z = Math.abs(a) < 0.8;
    if (z && g.current && !g.current.zero) vibrate();
    if (g.current) g.current.zero = z;
    onChange(z ? 0 : Math.round(a * 10) / 10);
  };
  return (
    <div className="ie-dial" dir="ltr" role="slider" tabIndex={0} aria-label={label} aria-valuemin={-45} aria-valuemax={45} aria-valuenow={angle} aria-valuetext={`${num(angle)}°`}
      style={{ "--off": `${-angle * 6}px` } as CSSProperties}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); g.current = { x: e.clientX, a: angle, zero: angle === 0 }; onStart(); }}
      onPointerMove={(e) => { if (g.current) set(clamp(g.current.a - (e.clientX - g.current.x) / 6, -45, 45)); }}
      onPointerUp={() => { if (g.current) { g.current = null; onEnd(); } }} onPointerCancel={() => { if (g.current) { g.current = null; onEnd(); } }}
      onDoubleClick={() => { onStart(); onChange(0); onEnd(); }}
      onKeyDown={(e) => {
        const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        if (d) { e.preventDefault(); onStart(); onChange(clamp(Math.round(angle) + d, -45, 45)); onEnd(); }
      }}>
      <span className="ie-dial-val">{num(Math.round(angle * 10) / 10)}°</span>
    </div>
  );
}

/** Typing a text: a real text box over the dimmed photo, its style, size and colour around it. */
function TextOverlay({ o: init, px, onDone, tools, onMore }: {
  o: TextObj; px: number; onDone: (o: TextObj) => void; onMore: (color: string, apply: (c: string) => void) => void;
  tools: (o: TextObj, set: (p: Partial<Pick<TextObj, "font" | "style" | "align">>) => void) => ReactNode;
}) {
  const [o, setO] = useState(init);
  const cur = useRef(o);
  cur.current = o;
  const ended = useRef(false);
  const finish = () => { if (!ended.current) { ended.current = true; onDone(cur.current); } };
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => pushBack(() => { finish(); }), []);
  useEffect(() => { const el = ta.current!; el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, []);
  const fontPx = o.size * o.scale * px, shownPx = clamp(fontPx, 14, 72), alt = contrast(o.color);
  const css: CSSProperties = {
    font: FONTS[o.font].replace("{s}", String(shownPx)), lineHeight: LINE, color: o.style === "box" ? alt : o.color,
    textAlign: o.align, ...(o.style === "box" && { background: o.color, borderRadius: shownPx * 0.3 }),
    ...(o.style === "outline" && { WebkitTextStroke: `${shownPx * 0.12}px ${alt}`, paintOrder: "stroke fill" }),
  };
  const set = (p: Partial<TextObj>) => setO((x) => ({ ...x, ...p }));
  return (
    <div className="ie-text" onPointerDown={(e) => { if (e.target === e.currentTarget) finish(); }}>
      <div className="ie-text-top">
        <button className="ie-done" aria-label={t("edit.done")} title={t("edit.done")} onClick={finish}><Icon name="check" /></button>
      </div>
      <div className="ie-text-mid" onPointerDown={(e) => { if (e.target === e.currentTarget) finish(); }}>
        <input type="range" className="ie-vsize" min={12} max={120} value={Math.round(clamp(fontPx, 12, 120))} aria-label={t("edit.size")}
          onChange={(e) => set({ scale: +e.target.value / (o.size * px) })} />
        <textarea ref={ta} dir="auto" value={o.text} rows={Math.max(1, o.text.split("\n").length)} placeholder={t("edit.textHint")} aria-label={t("edit.text")} style={css}
          onChange={(e) => set({ text: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); finish(); } }} />
      </div>
      <div className="ie-text-bar">
        <div className="ie-row">{tools(o, set)}</div>
        <Colors value={o.color} onChange={(c) => set({ color: c })} onMore={() => onMore(o.color, (c) => set({ color: c }))} />
      </div>
    </div>
  );
}

const hsvHex = (h: number, s: number, v: number) => {
  const f = (n: number) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return "#" + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, "0")).join("");
};
function hexHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const v = Math.max(r, g, b), d = v - Math.min(r, g, b);
  const h = !d ? 0 : v === r ? ((g - b) / d + 6) % 6 : v === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, v ? d / v : 0, v];
}

/** Any colour: shade square, hue strip, the eyedropper and the last ones picked. */
function ColorSheet({ color, recent, onPick, onDropper, onClose }: { color: string; recent: string[]; onPick: (c: string) => void; onDropper?: () => void; onClose: () => void }) {
  const [hsv, setHsv] = useState(() => hexHsv(color));
  const hex = hsvHex(...hsv);
  const sv = useRef<HTMLDivElement>(null);
  useEffect(() => pushBack(() => { onClose(); }), []);
  const drag = (e: RPE) => {
    const r = sv.current!.getBoundingClientRect();
    setHsv(([h]) => [h, clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)]);
  };
  return (
    <>
      <div className="ie-sheet-bg" onClick={onClose} />
      <div className="ie-sheet" role="dialog" aria-label={t("edit.moreColors")} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <div ref={sv} className="ie-sv" dir="ltr" role="slider" aria-label={t("edit.shade")} aria-valuetext={hex} tabIndex={0} style={{ "--hue": hsv[0] } as CSSProperties}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag(e); }} onPointerMove={(e) => { if (e.buttons) drag(e); }}>
          <span style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: hex }} />
        </div>
        <input type="range" className="ie-hue" dir="ltr" min={0} max={359} value={Math.round(hsv[0])} aria-label={t("edit.hue")}
          onChange={(e) => setHsv(([, s, v]) => [+e.target.value, s, v])} />
        <div className="ie-row">
          {onDropper && <button className="icon-btn" aria-label={t("edit.eyedropper")} title={t("edit.eyedropper")} onClick={onDropper}><Icon name="eyedropper" /></button>}
          {recent.length > 0 && (
            <div className="ie-colors" role="group" aria-label={t("edit.recent")}>
              {recent.map((c) => <button key={c} className="ie-swatch" style={{ background: c }} aria-label={c} onClick={() => onPick(c)} />)}
            </div>
          )}
          <span className="ie-grow" />
          <span className="ie-swatch ie-now" style={{ background: hex }} aria-hidden />
          <button className="ie-chip on" onClick={() => onPick(hex)}>{t("edit.done")}</button>
        </div>
      </div>
    </>
  );
}
