// UI language: picked once at startup (switching reloads), so module-level labels and formatters stay valid.
import fa from "./lang/fa.ts";
import en from "./lang/en.ts";

export type Lang = "fa" | "en";
export type Key = keyof typeof fa;
/** Each language in its own name, for the picker. */
export const LANGS: [Lang, string][] = [["fa", "فارسی"], ["en", "English"]];

/** False on a new install until the user picks on the first-start page (LangPick); Persian meanwhile. */
export let langChosen = true;
const pick = (): Lang => {
  if (typeof document === "undefined") return "fa"; // node --test: the tests assert Persian
  try {
    const prefs = JSON.parse(localStorage.getItem("panbeh.prefs") ?? "{}");
    if (prefs.lang === "fa" || prefs.lang === "en") return prefs.lang;
    // an install from before the English UI stays Persian; a new one asks
    if (["panbeh.prefs", "panbeh.sessions", "panbeh.session"].some((k) => localStorage.getItem(k))) {
      localStorage.setItem("panbeh.prefs", JSON.stringify({ ...prefs, lang: "fa" }));
    } else langChosen = false;
  } catch { /* no storage: the choice couldn't be kept anyway */ }
  return "fa";
};
export const lang = pick();
/** Every dictionary, for the first-start page: it speaks all the languages at once. */
export const DICTS = { fa, en } as const;
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
