// The photo editor's model: an edit is a small state (geometry, adjustments, strokes, objects) over the untouched
// original, so it stays editable until sent. One renderer draws it for the preview and for the export alike.
import { textDir } from "./logic.ts";

// ---------- 2D affine matrices, in canvas setTransform order (a b c d e f) ----------

export type Mat = [number, number, number, number, number, number];
export const I: Mat = [1, 0, 0, 1, 0, 0];
export const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
/** m₁ ∘ m₂ ∘ … (the last applies first). */
export const chain = (...ms: Mat[]) => ms.reduce(mul, I);
export function inv(m: Mat): Mat {
  const d = m[0] * m[3] - m[1] * m[2];
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
export const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
/** Clockwise on screen (y points down), like ctx.rotate. */
export const rotate = (rad: number): Mat => { const c = Math.cos(rad), s = Math.sin(rad); return [c, s, -s, c, 0, 0]; };
/** How much m scales lengths (its x axis). */
export const scaleOf = (m: Mat) => Math.hypot(m[0], m[1]);
const QUARTER: Mat[] = [[1, 0, 0, 1, 0, 0], [0, 1, -1, 0, 0, 0], [-1, 0, 0, -1, 0, 0], [0, -1, 1, 0, 0, 0]]; // exact 0/90/180/270°
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const RAD = Math.PI / 180;

// ---------- the edit ----------

export type Rect = { x: number; y: number; w: number; h: number };
export const ASPECTS = ["free", "orig", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"] as const;
export type Aspect = (typeof ASPECTS)[number];
/** Slider order. All −100…100 but fade and sharpen (0…100). */
export const ADJUST = ["brightness", "contrast", "saturation", "warmth", "fade", "highlights", "shadows", "vignette", "sharpen"] as const;
export type AdjustKey = (typeof ADJUST)[number];
export const UNIPOLAR = new Set<AdjustKey>(["fade", "sharpen"]);

export type StrokeTool = "pen" | "marker" | "neon" | "arrow" | "eraser" | "blur" | "pixelate";
/** pts: x, y, pressure triples in source px. `pressure`: a stylus drew it, so its width follows the pressure. */
export type Stroke = { tool: StrokeTool; color: string; size: number; pts: number[]; pressure?: boolean };

export type Font = "regular" | "bold" | "black" | "serif" | "mono";
export type TextStyle = "plain" | "outline" | "box";
export type Align = "start" | "center" | "end";
export type ShapeKind = "rect" | "ellipse" | "line" | "arrow";
/** x, y: the centre in source px; rot in radians; mirror: drawn flipped, to cancel a mirrored photo. */
type Placed = { id: number; x: number; y: number; rot: number; scale: number; mirror: boolean };
export type TextObj = Placed & { kind: "text"; text: string; font: Font; style: TextStyle; align: Align; color: string; size: number };
/** src: an emoji picture's URL or a sticker's blob URL; w, h: its size at scale 1, in source px. */
export type StickerObj = Placed & { kind: "sticker"; src: string; w: number; h: number };
/** Lines and arrows run along x for w; h is unused. */
export type ShapeObj = Placed & { kind: "shape"; shape: ShapeKind; color: string; width: number; fill: boolean; w: number; h: number };
export type Obj = TextObj | StickerObj | ShapeObj;

/** rot: quarter turns clockwise; flip: mirrored after the turn; angle: straightened by, degrees (−45…45).
 *  crop: in "canvas space": source px turned, mirrored and straightened about the photo's centre (orient()). */
export type EditState = {
  rot: number; flip: boolean; angle: number; crop: Rect; aspect: Aspect;
  adjust: Partial<Record<AdjustKey, number>>; strokes: Stroke[]; objects: Obj[];
};

export const blank = (W: number, H: number): EditState =>
  ({ rot: 0, flip: false, angle: 0, crop: { x: -W / 2, y: -H / 2, w: W, h: H }, aspect: "free", adjust: {}, strokes: [], objects: [] });

/** Source px → canvas space. */
export const orient = (s: EditState, W: number, H: number): Mat =>
  chain(rotate(s.angle * RAD), s.flip ? scale(-1, 1) : I, QUARTER[((s.rot % 4) + 4) % 4], translate(-W / 2, -H / 2));
/** The photo's size once turned. */
export const turned = (s: EditState, W: number, H: number) => (s.rot % 2 ? { ow: H, oh: W } : { ow: W, oh: H });

export function isBlank(s: EditState, W: number, H: number) {
  const c = s.crop, e = 0.5;
  return s.rot % 4 === 0 && !s.flip && !s.angle && !s.strokes.length && !s.objects.length && !Object.values(s.adjust).some(Boolean)
    && Math.abs(c.x + W / 2) < e && Math.abs(c.y + H / 2) < e && Math.abs(c.w - W) < e && Math.abs(c.h - H) < e;
}

/** Whether the crop lies on the straightened photo (corner extents in the photo's own axes). */
function extents(w: number, h: number, angle: number) {
  const a = angle * RAD, cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
  return { ex: (w / 2) * cos + (h / 2) * sin, ey: (w / 2) * sin + (h / 2) * cos };
}
export function cropFits(c: Rect, ow: number, oh: number, angle: number) {
  const { ex, ey } = extents(c.w, c.h, angle), [px, py] = apply(rotate(-angle * RAD), c.x + c.w / 2, c.y + c.h / 2);
  const tol = 1e-6 * (ow + oh);
  return Math.abs(px) + ex <= ow / 2 + tol && Math.abs(py) + ey <= oh / 2 + tol;
}
/** The crop shrunk about its centre (keeping its shape), then moved, until it lies on the straightened photo. */
export function fitCrop(c: Rect, ow: number, oh: number, angle: number): Rect {
  const { ex, ey } = extents(c.w, c.h, angle), k = Math.min(1, ow / 2 / ex, oh / 2 / ey);
  const w = c.w * k, h = c.h * k, mx = Math.max(0, ow / 2 - ex * k), my = Math.max(0, oh / 2 - ey * k);
  const [px, py] = apply(rotate(-angle * RAD), c.x + c.w / 2, c.y + c.h / 2);
  const [x, y] = apply(rotate(angle * RAD), clamp(px, -mx, mx), clamp(py, -my, my));
  return { x: x - w / 2, y: y - h / 2, w, h };
}
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t });
/** As far from `from` (valid) toward `to` as stays valid. */
export function limitCrop(from: Rect, to: Rect, ok: (r: Rect) => boolean): Rect {
  if (ok(to)) return to;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (ok(lerpRect(from, to, m))) lo = m; else hi = m; }
  return lerpRect(from, to, lo);
}

export function aspectRatio(a: Aspect, ow: number, oh: number) {
  if (a === "free") return null;
  if (a === "orig") return ow / oh;
  const [w, h] = a.split(":").map(Number);
  return w / h;
}
/** The biggest crop of ratio r about the current crop's centre. */
export function cropToRatio(c: Rect, r: number, ow: number, oh: number, angle: number) {
  const big = (ow + oh) * 4, cx = c.x + c.w / 2, cy = c.y + c.h / 2, w = r >= 1 ? big : big * r, h = r >= 1 ? big / r : big;
  return fitCrop({ x: cx - w / 2, y: cy - h / 2, w, h }, ow, oh, angle);
}

/** Turned a quarter anticlockwise on screen: the crop turns with it. (Mirrored, the source turns the other way.) */
export function turnLeft(s: EditState): EditState {
  const c = s.crop, a = s.aspect.includes(":") ? (s.aspect.split(":").reverse().join(":") as Aspect) : s.aspect;
  return { ...s, rot: (s.rot + (s.flip ? 1 : 3)) % 4, crop: { x: c.y, y: -c.x - c.w, w: c.h, h: c.w }, aspect: a };
}
/** Mirrored left ↔ right on screen. */
export const mirror = (s: EditState): EditState => ({ ...s, flip: !s.flip, angle: -s.angle || 0, crop: { ...s.crop, x: -s.crop.x - s.crop.w } });

// ---------- objects ----------

export const objMatrix = (o: Obj): Mat => chain(translate(o.x, o.y), rotate(o.rot), scale(o.mirror ? -o.scale : o.scale, o.scale));
/** Rotation and mirror that make a new object look upright (turned `screenRot`) under source → screen `m`. */
export function upright(m: Mat, screenRot = 0) {
  const mirrored = m[0] * m[3] - m[1] * m[2] < 0, lm = mirrored ? mul(m, scale(-1, 1)) : m, psi = Math.atan2(lm[1], lm[0]);
  return { mirror: mirrored, rot: mirrored ? psi - screenRot : screenRot - psi };
}
/** An object's turn on screen under source → screen `m`; turning it by Δ there is rot += mirroredView(m) ? −Δ : Δ. */
export function screenRot(m: Mat, o: Obj) {
  const u = upright(m), psi = u.mirror ? u.rot : -u.rot;
  return u.mirror ? psi - o.rot : psi + o.rot;
}
export const mirroredView = (m: Mat) => m[0] * m[3] - m[1] * m[2] < 0;

export const FONTS: Record<Font, string> = {
  regular: '400 {s}px "Vazirmatn Variable", sans-serif', bold: '700 {s}px "Vazirmatn Variable", sans-serif', black: '900 {s}px "Vazirmatn Variable", sans-serif',
  serif: '400 {s}px "Noto Naskh Arabic", "Times New Roman", serif', mono: '400 {s}px ui-monospace, "SF Mono", Menlo, monospace',
};
const fontOf = (f: Font, px: number) => FONTS[f].replace("{s}", String(px));
export const LINE = 1.3, PAD = 0.32; // line height and box padding, in font sizes

let measurer: CanvasRenderingContext2D | null = null;
type Laid = { lines: { text: string; w: number; dir: "rtl" | "ltr" }[]; w: number; h: number; dir: "rtl" | "ltr" };
/** A text's lines and its box at scale 1 (padding included). */
export function layText(o: TextObj, g?: CanvasRenderingContext2D): Laid {
  g ??= measurer ??= document.createElement("canvas").getContext("2d")!;
  g.font = fontOf(o.font, o.size);
  const lines = o.text.split("\n").map((text) => ({ text, w: g.measureText(text).width, dir: textDir(text || o.text) }));
  const pad = o.size * PAD;
  return { lines, w: Math.max(...lines.map((l) => l.w), o.size * 0.5) + pad * 2, h: lines.length * o.size * LINE + pad * 2, dir: textDir(o.text) };
}
/** The object's box at scale 1, centred on (0, 0). */
export function objSize(o: Obj) {
  if (o.kind === "text") return layText(o);
  if (o.kind === "sticker") return { w: o.w, h: o.h };
  return o.shape === "line" || o.shape === "arrow" ? { w: o.w + o.width * 2, h: o.width * 6 } : { w: o.w + o.width, h: o.h + o.width };
}

export const contrast = (hex: string) => {
  const n = parseInt(hex.slice(1), 16), [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 160 ? "#000000" : "#ffffff";
};

// ---------- drawing ----------

const images = new Map<string, HTMLImageElement>();
/** A sticker's picture; `onLoad` once it's ready if it wasn't. */
export function image(src: string, onLoad?: () => void) {
  let img = images.get(src);
  if (!img) {
    img = new Image();
    if (/^https?:/.test(src)) img.crossOrigin = "anonymous"; // jsDelivr allows it; without it the export canvas is tainted
    img.src = src;
    images.set(src, img);
  }
  if (!img.complete && onLoad) img.addEventListener("load", onLoad, { once: true });
  return img;
}
const loaded = (objects: Obj[]) => Promise.all(objects.flatMap((o) => o.kind === "sticker" ? [image(o.src).decode().catch(() => {})] : []));

function strokePath(g: CanvasRenderingContext2D, p: number[]) {
  const n = p.length / 3;
  g.beginPath();
  g.moveTo(p[0], p[1]);
  if (n === 1) g.lineTo(p[0] + 0.01, p[1]); // a tap: a dot
  for (let i = 1; i < n - 1; i++) g.quadraticCurveTo(p[i * 3], p[i * 3 + 1], (p[i * 3] + p[i * 3 + 3]) / 2, (p[i * 3 + 1] + p[i * 3 + 4]) / 2);
  if (n > 1) g.lineTo(p[n * 3 - 3], p[n * 3 - 2]);
}
/** An open arrowhead at (x, y), pointing away from (fx, fy). */
function arrowHead(g: CanvasRenderingContext2D, x: number, y: number, fx: number, fy: number, size: number) {
  const a = Math.atan2(y - fy, x - fx), len = size * 3.2;
  g.beginPath();
  g.moveTo(x - len * Math.cos(a - 0.5), y - len * Math.sin(a - 0.5));
  g.lineTo(x, y);
  g.lineTo(x - len * Math.cos(a + 0.5), y - len * Math.sin(a + 0.5));
  g.stroke();
}
/** px: device px per source px, for the glow (shadowBlur ignores the transform). */
export function drawStroke(g: CanvasRenderingContext2D, st: Stroke, px: number) {
  const p = st.pts, n = p.length / 3;
  g.save();
  g.lineCap = "round"; g.lineJoin = "round"; g.lineWidth = st.size; g.strokeStyle = st.color;
  if (st.tool === "eraser") g.globalCompositeOperation = "destination-out";
  if (st.tool === "blur" || st.tool === "pixelate") g.strokeStyle = "#000";
  if (st.tool === "marker") { g.globalAlpha = 0.55; g.lineWidth = st.size * 1.6; }
  if (st.tool === "pen" && st.pressure && n > 1) {
    for (let i = 1; i < n; i++) { // ponytail: straight segments under pressure, curves only without it
      g.lineWidth = st.size * (0.25 + 1.5 * (p[i * 3 - 1] + p[i * 3 + 2]) / 2);
      g.beginPath(); g.moveTo(p[i * 3 - 3], p[i * 3 - 2]); g.lineTo(p[i * 3], p[i * 3 + 1]); g.stroke();
    }
  } else if (st.tool === "neon") {
    strokePath(g, p);
    g.shadowColor = st.color; g.shadowBlur = st.size * 1.4 * px;
    g.stroke(); g.stroke();
    g.shadowBlur = 0; g.lineWidth = st.size * 0.4; g.strokeStyle = "rgba(255,255,255,0.9)";
    g.stroke();
  } else {
    strokePath(g, p);
    g.stroke();
  }
  if (st.tool === "arrow" && n > 1) {
    let j = n - 2; // a point far enough back for a steady direction
    while (j > 0 && Math.hypot(p[n * 3 - 3] - p[j * 3], p[n * 3 - 2] - p[j * 3 + 1]) < st.size * 3) j--;
    arrowHead(g, p[n * 3 - 3], p[n * 3 - 2], p[j * 3], p[j * 3 + 1], st.size);
  }
  g.restore();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
}

/** An object, its centre at (0, 0) under the current transform. */
export function drawObj(g: CanvasRenderingContext2D, o: Obj, onLoad?: () => void) {
  if (o.kind === "sticker") {
    const img = image(o.src, onLoad);
    if (img.complete && img.naturalWidth) g.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
    return;
  }
  if (o.kind === "shape") {
    g.lineWidth = o.width; g.strokeStyle = g.fillStyle = o.color; g.lineCap = "round"; g.lineJoin = "round";
    if (o.shape === "line" || o.shape === "arrow") {
      g.beginPath(); g.moveTo(-o.w / 2, 0); g.lineTo(o.w / 2, 0); g.stroke();
      if (o.shape === "arrow") arrowHead(g, o.w / 2, 0, -o.w / 2, 0, o.width);
      return;
    }
    g.beginPath();
    if (o.shape === "rect") g.roundRect ? g.roundRect(-o.w / 2, -o.h / 2, o.w, o.h, Math.min(o.w, o.h) * 0.06) : g.rect(-o.w / 2, -o.h / 2, o.w, o.h);
    else g.ellipse(0, 0, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
    if (o.fill) g.fill(); else g.stroke();
    return;
  }
  const lay = layText(o, g), lh = o.size * LINE, pad = o.size * PAD, inner = lay.w - pad * 2;
  const top = -lay.h / 2 + pad, alt = contrast(o.color);
  // start/end follow the text's own direction: start is the right edge for Persian
  const left = (w: number) => o.align === "center" ? -w / 2 : (o.align === "start") === (lay.dir === "ltr") ? -inner / 2 : inner / 2 - w;
  g.textBaseline = "middle"; g.textAlign = "left"; g.lineJoin = "round";
  if (o.style === "box") {
    g.fillStyle = o.color;
    lay.lines.forEach((l, i) => {
      if (!l.text.trim()) return;
      roundRect(g, left(l.w) - pad, top + i * lh - pad * 0.15, l.w + pad * 2, lh + pad * 0.3, lh * 0.28);
      g.fill();
    });
  }
  lay.lines.forEach((l, i) => {
    g.direction = l.dir;
    const x = left(l.w), y = top + i * lh + lh / 2;
    if (o.style === "outline") { g.strokeStyle = alt; g.lineWidth = o.size * 0.2; g.strokeText(l.text, x, y); }
    g.fillStyle = o.style === "box" ? alt : o.color;
    g.fillText(l.text, x, y);
  });
}

// ---------- adjustments (WebGL) ----------

const VS = "attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}";
const FS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v;uniform sampler2D t;uniform vec2 d;uniform float br,ct,sa,wa,fa,hi,sh,sp;
const vec3 Y=vec3(.2126,.7152,.0722);
void main(){
  vec4 px=texture2D(t,v);vec3 c=px.a>0.?px.rgb/px.a:px.rgb;
  if(sp>0.){vec4 n=texture2D(t,v+vec2(d.x,0.))+texture2D(t,v-vec2(d.x,0.))+texture2D(t,v+vec2(0.,d.y))+texture2D(t,v-vec2(0.,d.y));
    vec3 m=n.a>0.?n.rgb/n.a:n.rgb;c+=(c-m)*sp*1.6;}
  float l=dot(clamp(c,0.,1.),Y);
  c+=sh*.35*(1.-smoothstep(0.,.6,l));
  c+=hi*.35*smoothstep(.4,1.,l);
  c=pow(max(c,0.),vec3(exp2(-br*.8)));
  c=(c-.5)*(1.+ct*(ct>0.?1.:.7))+.5;
  c=mix(vec3(dot(c,Y)),c,1.+sa*(sa>0.?.9:1.));
  c+=vec3(.1,.02,-.1)*wa;
  c=mix(c,c*.78+.16,fa);
  gl_FragColor=vec4(clamp(c,0.,1.)*px.a,px.a);
}`;
const UNIFORMS: [string, AdjustKey][] = [["br", "brightness"], ["ct", "contrast"], ["sa", "saturation"], ["wa", "warmth"], ["fa", "fade"], ["hi", "highlights"], ["sh", "shadows"], ["sp", "sharpen"]];
const inShader = (a: EditState["adjust"]) => UNIFORMS.some(([, k]) => a[k]);

let maxTex: number | undefined;
/** The biggest texture WebGL takes here; 0 without WebGL (no adjustments then). */
export function glMax() {
  if (maxTex === undefined) {
    const gl = document.createElement("canvas").getContext("webgl");
    maxTex = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) as number : 0;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return maxTex;
}

type Pic = HTMLCanvasElement | ImageBitmap;
const canvas = (w: number, h: number) => Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });

/** Halves until under `w`×`h`, then draws there: smoother than one big step. */
function shrink(src: Pic, w: number, h: number) {
  let cur: Pic = src;
  while (cur.width / 2 > w) {
    const c = canvas(cur.width / 2, cur.height / 2), g = c.getContext("2d")!;
    g.imageSmoothingQuality = "high"; g.drawImage(cur, 0, 0, c.width, c.height); cur = c;
  }
  const c = canvas(w, h), g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high"; g.drawImage(cur, 0, 0, c.width, c.height);
  return c;
}

/** Draws an edit of one picture. `pic` may be smaller than the source (W×H): everything is kept in source px. */
export class Renderer {
  readonly k: number; // pic px per source px
  private gl?: { c: HTMLCanvasElement; g: WebGLRenderingContext; p: WebGLProgram; key: string };
  private baseKey = "";
  private fx = new Map<"blur" | "pixelate", { src: Pic; key: string; mask: HTMLCanvasElement; out: HTMLCanvasElement; strokes: Stroke[]; dirty: boolean }>();
  private ink?: { c: HTMLCanvasElement; strokes: Stroke[] };
  private scratch?: HTMLCanvasElement;
  readonly pic: Pic; readonly W: number; readonly H: number; private onLoad?: () => void;
  constructor(pic: Pic, W: number, H: number, onLoad?: () => void) { this.pic = pic; this.W = W; this.H = H; this.onLoad = onLoad; this.k = pic.width / W; }

  /** The picture with the adjustments' shader pass (the vignette is drawn over the crop instead). */
  base(a: EditState["adjust"]): Pic {
    if (!inShader(a) || !glMax()) { this.baseKey = ""; return this.pic; }
    if (!this.gl) {
      const c = canvas(this.pic.width, this.pic.height), g = c.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: true })!;
      const sh = (type: number, src: string) => { const s = g.createShader(type)!; g.shaderSource(s, src); g.compileShader(s); return s; };
      const p = g.createProgram()!;
      g.attachShader(p, sh(g.VERTEX_SHADER, VS)); g.attachShader(p, sh(g.FRAGMENT_SHADER, FS)); g.linkProgram(p); g.useProgram(p);
      g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer()); g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
      const loc = g.getAttribLocation(p, "p"); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
      g.bindTexture(g.TEXTURE_2D, g.createTexture());
      g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, this.pic);
      for (const [k, v] of [[g.TEXTURE_MIN_FILTER, g.LINEAR], [g.TEXTURE_MAG_FILTER, g.LINEAR], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]]) g.texParameteri(g.TEXTURE_2D, k, v);
      this.gl = { c, g, p, key: "" };
    }
    const { c, g, p } = this.gl, key = JSON.stringify(UNIFORMS.map(([, k]) => a[k] ?? 0));
    this.baseKey = key;
    if (this.gl.key !== key) {
      this.gl.key = key;
      // sharpening reaches the same share of the photo at any resolution, so preview and export agree
      const r = Math.max(1, Math.max(c.width, c.height) / 1500);
      g.viewport(0, 0, c.width, c.height);
      g.uniform2f(g.getUniformLocation(p, "d"), r / c.width, r / c.height);
      for (const [u, k] of UNIFORMS) g.uniform1f(g.getUniformLocation(p, u), (a[k] ?? 0) / 100);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    }
    return c;
  }

  /** The blurred or pixelated photo (src), and its strokes' mask over it (out); remade when the adjustments change. */
  private fxEntry(kind: "blur" | "pixelate", base: Pic) {
    let f = this.fx.get(kind);
    if (!f || f.key !== this.baseKey) {
      const { width: w, height: h } = base, long = Math.max(w, h), src = canvas(w, h), g = src.getContext("2d")!;
      if (kind === "blur") { // strong enough to hide text and faces; the radius is a share of the photo, so preview and export agree
        g.drawImage(base, 0, 0);
        // ponytail: older Safari has no ctx.filter; a downscaled copy blurs there, more coarsely
        if ("filter" in (g as object)) { g.filter = `blur(${long / 45}px)`; g.drawImage(base, 0, 0); g.filter = "none"; }
        else { g.imageSmoothingQuality = "high"; g.drawImage(shrink(base, Math.max(1, w / 40), Math.max(1, h / 40)), 0, 0, w, h); }
      }
      else { const cell = Math.max(2, long / 64); g.imageSmoothingEnabled = false; g.drawImage(shrink(base, Math.max(1, w / cell), Math.max(1, h / cell)), 0, 0, w, h); }
      f = { src, key: this.baseKey, mask: f?.mask ?? canvas(w, h), out: f?.out ?? canvas(w, h), strokes: f?.strokes ?? [], dirty: true };
      this.fx.set(kind, f);
    }
    return f;
  }

  /** The masked effect, redrawn incrementally while strokes are only added. */
  private effect(kind: "blur" | "pixelate", base: Pic, strokes: Stroke[]) {
    const mine = strokes.filter((s) => s.tool === kind), f = this.fxEntry(kind, base);
    const appended = f.strokes.length <= mine.length && f.strokes.every((s, i) => s === mine[i]);
    const g = f.mask.getContext("2d")!;
    if (!appended) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, f.mask.width, f.mask.height); f.dirty = true; }
    const added = appended ? mine.slice(f.strokes.length) : mine;
    g.setTransform(this.k, 0, 0, this.k, 0, 0);
    for (const s of added) drawStroke(g, s, this.k);
    if (added.length) f.dirty = true;
    f.strokes = mine;
    if (f.dirty) {
      const o = f.out.getContext("2d")!;
      o.globalCompositeOperation = "copy"; o.drawImage(f.mask, 0, 0);
      o.globalCompositeOperation = "source-in"; o.drawImage(f.src, 0, 0);
      o.globalCompositeOperation = "source-over";
      f.dirty = false;
    }
    return f.out;
  }

  /** Pen, marker, neon and arrow strokes, with the eraser taken out (incremental like effect()). */
  private inkLayer(strokes: Stroke[]) {
    const mine = strokes.filter((s) => s.tool !== "blur" && s.tool !== "pixelate");
    const i = this.ink ??= { c: canvas(this.pic.width, this.pic.height), strokes: [] };
    const appended = i.strokes.length <= mine.length && i.strokes.every((s, j) => s === mine[j]);
    const g = i.c.getContext("2d")!;
    if (!appended) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, i.c.width, i.c.height); }
    g.setTransform(this.k, 0, 0, this.k, 0, 0);
    for (const s of appended ? mine.slice(i.strokes.length) : mine) drawStroke(g, s, this.k);
    i.strokes = mine;
    return mine.length ? i.c : null;
  }

  private temp() {
    const c = this.scratch ??= canvas(this.pic.width, this.pic.height), g = c.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
    return { c, g };
  }

  /** The edit through `m` (source px → ctx px). clip: only the crop shows; original: the photo with no edits at all;
   *  active: a stroke being drawn; hide: an object left out (being edited elsewhere). */
  draw(ctx: CanvasRenderingContext2D, s: EditState, m: Mat, o: { clip?: boolean; original?: boolean; active?: Stroke | null; hide?: number } = {}) {
    const toCtx = mul(m, inv(orient(s, this.W, this.H))), toPic = mul(m, scale(1 / this.k)), px = scaleOf(m), c = s.crop;
    ctx.save();
    ctx.imageSmoothingQuality = "high";
    if (o.clip) { ctx.setTransform(...toCtx); ctx.beginPath(); ctx.rect(c.x, c.y, c.w, c.h); ctx.clip(); }
    ctx.setTransform(...toPic);
    if (o.original) { ctx.drawImage(this.pic, 0, 0); ctx.restore(); return; }
    const base = this.base(s.adjust);
    ctx.drawImage(base, 0, 0);
    const act = o.active;
    for (const kind of ["blur", "pixelate"] as const) {
      if (s.strokes.some((st) => st.tool === kind)) ctx.drawImage(this.effect(kind, base, s.strokes), 0, 0);
      if (act?.tool === kind) {
        const t = this.temp();
        t.g.setTransform(this.k, 0, 0, this.k, 0, 0); drawStroke(t.g, act, this.k);
        t.g.setTransform(1, 0, 0, 1, 0, 0); t.g.globalCompositeOperation = "source-in"; t.g.drawImage(this.fxEntry(kind, base).src, 0, 0);
        t.g.globalCompositeOperation = "source-over";
        ctx.drawImage(t.c, 0, 0);
      }
    }
    const v = s.adjust.vignette ?? 0;
    if (v) {
      ctx.setTransform(...toCtx);
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2, r = Math.hypot(c.w, c.h) / 2;
      const grad = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
      const tint = v > 0 ? "0,0,0" : "255,255,255";
      grad.addColorStop(0, `rgba(${tint},0)`); grad.addColorStop(1, `rgba(${tint},${Math.abs(v) / 100 * 0.75})`);
      ctx.fillStyle = grad; ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.setTransform(...toPic);
    }
    const ink = this.inkLayer(s.strokes);
    if (act?.tool === "eraser") {
      if (ink) { const t = this.temp(); t.g.drawImage(ink, 0, 0); t.g.setTransform(this.k, 0, 0, this.k, 0, 0); drawStroke(t.g, act, this.k); ctx.drawImage(t.c, 0, 0); }
    } else {
      if (ink) ctx.drawImage(ink, 0, 0);
      if (act && act.tool !== "blur" && act.tool !== "pixelate") { ctx.setTransform(...m); drawStroke(ctx, act, px); }
    }
    for (const ob of s.objects) {
      if (ob.id === o.hide) continue;
      ctx.save();
      ctx.setTransform(...mul(m, objMatrix(ob)));
      drawObj(ctx, ob, this.onLoad);
      ctx.restore();
    }
    ctx.restore();
  }

  dispose() {
    this.gl?.g.getExtension("WEBGL_lose_context")?.loseContext();
    if ("close" in this.pic) this.pic.close();
  }
}

// ---------- loading and export ----------

export const PREVIEW = 2560;
const MAX_AREA = 16_700_000; // iOS caps canvases there; Android WebViews can go further, but not reliably

/** The photo, decoded upright (EXIF), scaled to fit `long` px and `area`; its natural size too. */
export async function decode(file: Blob, long: number, area = MAX_AREA) {
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height, k = Math.min(1, long / Math.max(W, H), Math.sqrt(area / (W * H)));
  if (k >= 1) return { pic: bmp as Pic, W, H };
  const pic = shrink(bmp, W * k, H * k);
  bmp.close();
  return { pic: pic as Pic, W, H };
}

/** The edited photo as a file. PNG stays PNG (screenshots stay sharp); the rest is JPEG. `max`: longest side, px. */
export async function exportEdit(file: File, s: EditState, max?: number): Promise<File> {
  const gl = inShader(s.adjust) ? glMax() : 0;
  const { pic, W, H } = await decode(file, gl || 16384);
  const r = new Renderer(pic, W, H);
  try {
    await loaded(s.objects);
    const k = Math.min(r.k, max ? max / Math.max(s.crop.w, s.crop.h) : Infinity);
    const out = canvas(s.crop.w * k, s.crop.h * k), g = out.getContext("2d")!;
    const png = /^image\/(png|webp)$/.test(file.type), type = png ? "image/png" : "image/jpeg";
    if (!png) { g.fillStyle = "#fff"; g.fillRect(0, 0, out.width, out.height); } // JPEG has no alpha
    r.draw(g, s, chain(scale(out.width / s.crop.w, out.height / s.crop.h), translate(-s.crop.x, -s.crop.y), orient(s, W, H)), { clip: true });
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, type, 0.95));
    if (!blob) throw new Error("export");
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + (png ? ".png" : ".jpg"), { type });
  } finally { r.dispose(); }
}

/** Edited files → the original and the edit, so reopening one keeps every layer editable. */
export const edits = new WeakMap<File, { original: File; state: EditState }>();
