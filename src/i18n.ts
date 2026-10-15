// UI language: picked once at startup (switching reloads), so module-level labels and formatters stay valid.
import fa from "./lang/fa.ts";
import en from "./lang/en.ts";

export type Lang = "fa" | "en";
export type Key = keyof typeof fa;
/** Each language in its own name, for the picker. */
export const LANGS: [Lang, string][] = [["fa", "فارسی"], ["en", "English"]];

const pick = (): Lang => {
  if (typeof document === "undefined") return "fa"; // node --test: the tests assert Persian
  try { const l = JSON.parse(localStorage.getItem("panbeh.prefs") ?? "{}").lang; if (l === "fa" || l === "en") return l; } catch { /* no storage */ }
  return navigator.language.toLowerCase().startsWith("fa") ? "fa" : "en";
};
export const lang = pick();
export const rtl = lang === "fa";
export const LOCALE = lang === "fa" ? "fa-IR" : "en-US"; // fa-IR: Jalali calendar + Persian digits

const dict: Record<string, string> = lang === "fa" ? fa : en;
const NUM = new Intl.NumberFormat(LOCALE), PLURAL = new Intl.PluralRules(LOCALE);

/** The text for `key`, with {name}s filled in (numbers in the language's digits). A numeric `count` picks
 *  `key.one` / `key.other` when the language has them ("1 reply", "2 replies"). */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const s = (typeof vars?.count === "number" && dict[`${key}.${PLURAL.select(vars.count)}`]) || dict[key];
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => { const v = vars[k]; return typeof v === "number" ? NUM.format(v) : String(v ?? ""); }) : s;
}

/** Saves the choice and reloads into it. */
export function setLang(l: Lang) {
  try { localStorage.setItem("panbeh.prefs", JSON.stringify({ ...JSON.parse(localStorage.getItem("panbeh.prefs") ?? "{}"), lang: l })); } catch { /* no storage: this session only */ }
  location.reload();
}

if (typeof document !== "undefined") {
  document.documentElement.lang = lang;
  document.documentElement.dir = rtl ? "rtl" : "ltr";
  document.title = t("app.name");
}
