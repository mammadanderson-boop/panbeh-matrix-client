import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, blank, cropFits, cropToRatio, fitCrop, inv, isBlank, limitCrop, mirror, mul, objMatrix, orient, rotate, screenRot, turnLeft, turned, upright, type EditState, type Obj } from "./imageEdit.ts";

const W = 400, H = 300;
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≉ ${b}`);
const corners = (s: EditState) => { const c = s.crop; return [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]]; };
/** Every crop corner maps back inside the source photo. */
const onPhoto = (s: EditState) => corners(s).every(([x, y]) => { const [u, v] = apply(inv(orient(s, W, H)), x, y); return u > -1e-6 && v > -1e-6 && u < W + 1e-6 && v < H + 1e-6; });

test("orient round-trips under every turn, mirror and straighten", () => {
  for (const rot of [0, 1, 2, 3]) for (const flip of [false, true]) for (const angle of [0, 12.5, -45]) {
    const m = orient({ ...blank(W, H), rot, flip, angle }, W, H);
    const [x, y] = apply(inv(m), ...apply(m, 37, 251));
    near(x, 37); near(y, 251);
    const [cx, cy] = apply(m, W / 2, H / 2); // the photo's centre is the origin
    near(cx, 0); near(cy, 0);
  }
});

test("turning and mirroring keep the crop on the same part of the photo", () => {
  let s: EditState = { ...blank(W, H), crop: { x: -150, y: -100, w: 120, h: 90 }, aspect: "4:3" };
  const src = (st: EditState) => corners(st).map(([x, y]) => apply(inv(orient(st, W, H)), x, y)).flat().sort((a, b) => a - b);
  const before = src(s);
  for (const step of [turnLeft, mirror, turnLeft, turnLeft, mirror, turnLeft]) {
    s = step(s);
    src(s).forEach((v, i) => near(v, before[i]));
  }
  assert.equal(turnLeft(blank(W, H)).aspect, "free");
  assert.equal(turnLeft({ ...blank(W, H), aspect: "16:9" }).aspect, "9:16");
  const t = turnLeft(blank(W, H));
  assert.deepEqual(turned(t, W, H), { ow: H, oh: W });
  near(t.crop.w, H); near(t.crop.h, W);
});

test("four left turns and two mirrors are no edit", () => {
  let s = blank(W, H);
  for (let i = 0; i < 4; i++) s = turnLeft(s);
  s = mirror(mirror(s));
  assert.ok(isBlank(s, W, H));
  assert.ok(!isBlank(turnLeft(blank(W, H)), W, H));
  assert.ok(!isBlank({ ...blank(W, H), adjust: { contrast: 10 } }, W, H));
  assert.ok(isBlank({ ...blank(W, H), adjust: { contrast: 0 } }, W, H));
});

test("fitCrop keeps a straightened crop on the photo, shrinking only as needed", () => {
  for (const angle of [0, 5, -20, 45]) {
    const s = { ...blank(W, H), angle };
    const c = fitCrop(s.crop, W, H, angle);
    assert.ok(cropFits(c, W, H, angle));
    assert.ok(onPhoto({ ...s, crop: c }));
    near(c.w / c.h, W / H); // same shape
    if (!angle) assert.deepEqual(c, s.crop);
    // a crop already on the photo stays put
    const small = { x: -20, y: -10, w: 40, h: 30 };
    if (angle !== 45) assert.deepEqual(fitCrop(small, W, H, angle), small);
  }
  // pushed off the side, it slides back on without shrinking
  const off = fitCrop({ x: 150, y: -10, w: 100, h: 50 }, W, H, 0);
  near(off.x, 100); near(off.w, 100);
});

test("limitCrop stops at the photo's edge", () => {
  const from = { x: -50, y: -50, w: 100, h: 100 }, to = { x: -50, y: -50, w: 400, h: 100 };
  const r = limitCrop(from, to, (c) => cropFits(c, W, H, 0));
  near(r.x + r.w, W / 2, 0.01);
});

test("cropToRatio picks the biggest crop of that shape", () => {
  const sq = cropToRatio(blank(W, H).crop, 1, W, H, 0);
  near(sq.w, H); near(sq.h, H); near(sq.x, -H / 2);
  const wide = cropToRatio(blank(W, H).crop, 16 / 9, W, H, 10);
  near(wide.w / wide.h, 16 / 9);
  assert.ok(cropFits(wide, W, H, 10));
});

test("a new object looks upright however the photo is turned or mirrored", () => {
  for (const rot of [0, 1, 2, 3]) for (const flip of [false, true]) for (const angle of [0, 30]) {
    const view = mul([2, 0, 0, 2, 100, 50], orient({ ...blank(W, H), rot, flip, angle }, W, H));
    const u = upright(view, 0.3);
    const o: Obj = { id: 1, kind: "sticker", src: "", w: 10, h: 10, x: 0, y: 0, scale: 1, ...u };
    const m = mul(view, objMatrix(o));
    near(Math.atan2(m[1], m[0]), 0.3); // its x axis points 0.3 rad round on screen
    assert.ok(m[0] * m[3] - m[1] * m[2] > 0); // and it isn't mirrored
    near(screenRot(view, o), 0.3);
  }
});

test("rotate is clockwise on screen", () => {
  const [x, y] = apply(rotate(Math.PI / 2), 1, 0);
  near(x, 0); near(y, 1);
});
