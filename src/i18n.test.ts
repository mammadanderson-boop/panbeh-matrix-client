import { test } from "node:test";
import assert from "node:assert/strict";
import fa from "./lang/fa.ts";
import en from "./lang/en.ts";
import { t } from "./i18n.ts";

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("every translation fills the same {placeholders} as the Persian", () => {
  const e = en as Record<string, string>;
  for (const [k, v] of Object.entries(fa)) assert.deepEqual(vars(e[k]), vars(v), k);
  for (const k of Object.keys(e).filter((k) => k.endsWith(".one"))) {
    const base = k.slice(0, -4);
    assert.ok(base in fa, `${k} has no base key`);
    // the singular may spell the number out ("Every minute"), but adds nothing
    assert.ok(vars(e[k]).every((x) => vars(e[base]).includes(x)), k);
  }
});

test("t fills placeholders, numbers in Persian digits", () => {
  assert.equal(t("roomName.more", { a: "علی", count: 3 }), "علی و ۳ نفر دیگر");
  assert.equal(t("poll.pct", { n: 40 }), "۴۰٪");
});
