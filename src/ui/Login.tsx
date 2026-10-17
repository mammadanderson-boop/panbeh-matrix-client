import { DICTS, LANGS, lang, setLang, t } from "../i18n.ts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { login, loginMode, register, registerInfo, startOAuth, type RegisterInfo } from "../matrix.ts";
import { normalizeServer } from "../logic.ts";
import { errText } from "./common.tsx";
import { isDesktop } from "../desktop.ts";
import { Icon } from "../icons.tsx";
import logo from "../logo.svg";

/** First start on a new install, before login: the logo, «پنبه» and one button per language. Picking saves and reloads into it. */
export function LangPick() {
  return (
    <div className="login wallpaper">
      <div className="login-card lang-pick">
        <img className="login-logo" src={logo} alt="" />
        <h1 lang="fa">{DICTS.fa["app.name"]}</h1>
        <p className="lang-hint">{LANGS.map(([l], i) => <span key={l}>{i > 0 && " · "}<span lang={l} dir={l === "fa" ? "rtl" : "ltr"}>{DICTS[l]["lang.choose"]}</span></span>)}</p>
        {LANGS.map(([l, name]) => <button key={l} className="primary" lang={l} onClick={() => setLang(l)}>{name}</button>)}
      </div>
    </div>
  );
}

// only here does M_FORBIDDEN mean bad credentials; elsewhere it's a missing permission
const loginErr = (e: unknown) => ((e as { errcode?: string })?.errcode === "M_FORBIDDEN" ? t("login.wrong") : errText(e));

/** A terms policy's name and link in our language, else its first one. */
const policyText = (p: Record<string, unknown>) =>
  (p[lang] ?? Object.values(p).find((v) => typeof v === "object")) as { name?: string; url?: string } | undefined;

export function Login({ onDone, initialError, onCancel }: { onDone: () => void; initialError?: unknown; onCancel?: () => void }) {
  const [server, setServer] = useState(localStorage.getItem("panbeh.lastServer") ?? "");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ? errText(initialError) : "");
  const [inBrowser, setInBrowser] = useState(false); // desktop: the login page is open in the browser
  // "" = not checked yet (or unreachable)
  const [mode, setMode] = useState<"" | "checking" | "oauth" | "password">("");
  const [info, setInfo] = useState<RegisterInfo | null>(null); // null = the server doesn't take sign-ups here
  const [creating, setCreating] = useState(false);
  const [password2, setPassword2] = useState("");
  const [token, setToken] = useState("");
  const [agreed, setAgreed] = useState(false);
  const latest = useRef(server);
  latest.current = server;

  async function check(s: string) {
    setMode("checking");
    try {
      const m = await loginMode(normalizeServer(s));
      const r = await registerInfo(normalizeServer(s), m).catch(() => null);
      if (latest.current === s) { setMode(m); setInfo(r); if (!r) setCreating(false); }
    } catch (err) {
      if (latest.current === s) { setMode(""); setError(errText(err)); }
    }
  }

  // once typing stops, ask the server how it logs in
  useEffect(() => {
    setMode("");
    setInfo(null);
    if (!server.trim()) return;
    const t = setTimeout(() => check(server), 700);
    return () => clearTimeout(t);
  }, [server]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "") return check(server); // Enter before the check ran, or retry after an error
    if (creating && mode === "password" && password !== password2) return setError(t("register.mismatch"));
    setBusy(true);
    setError("");
    try {
      localStorage.setItem("panbeh.lastServer", server);
      if (mode === "oauth") {
        await startOAuth(server, creating); // navigates away; the desktop app opens the browser and stays
        if (isDesktop) { setInBrowser(true); setBusy(false); }
        return;
      }
      await (creating ? register(server, user, password, info!, token) : login(server, user, password));
      onDone();
    } catch (err) {
      setError(creating ? errText(err) : loginErr(err));
      setBusy(false);
    }
  }

  return (
    <div className="login wallpaper">
      <form className="login-card" onSubmit={submit}>
        <img className="login-logo" src={logo} alt="" />
        <h1>{t(creating ? "register.title" : "login.title")}</h1>
        <label>
          {t("login.server")}
          <input dir="ltr" value={server} onChange={(e) => { setServer(e.target.value); setError(""); }} placeholder="matrix.example.org:8448" required autoFocus />
        </label>
        {mode === "password" && <>
          <label>
            {t("login.user")}
            <input dir="ltr" value={user} onChange={(e) => setUser(e.target.value)} placeholder="alice" autoComplete="username" required autoFocus />
          </label>
          <label>
            {t("login.password")}
            <input dir="ltr" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={creating ? "new-password" : "current-password"} required />
          </label>
          {creating && <>
            <label>
              {t("register.confirm")}
              <input dir="ltr" type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required />
            </label>
            {info?.flow.includes("m.login.registration_token") && <label>
              {t("register.token")}
              <input dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
            </label>}
            {info?.flow.includes("m.login.terms") && <label className="login-terms">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} required />
              <span>{t("register.terms")}{" "}
                {info.policies.map(policyText).filter((p) => p?.url).map((p, i) => <span key={i}>{i > 0 && t("list.sep")}<a href={p!.url} target="_blank" rel="noopener">{p!.name || p!.url}</a></span>)}
              </span>
            </label>}
          </>}
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        {inBrowser && !error && <p className="muted">{t("login.inBrowser")}</p>}
        <button className="primary" disabled={busy || mode === "checking"}>
          {busy ? t(creating ? "register.busy" : "login.signingIn")
            : { "": t("login.continue"), checking: t("login.checking"), oauth: t(creating ? "register.oauth" : "login.oauth"), password: t(creating ? "register.submit" : "login.signIn") }[mode]}
        </button>
        {info && !busy && <button type="button" className="login-switch" onClick={() => { setCreating(!creating); setError(""); }}>
          {t(creating ? "register.haveAccount" : "register.link")}
        </button>}
        {onCancel && <button type="button" onClick={onCancel}>{t("common.dismiss")}</button>}
        {/* in the language it switches to, so someone who can't read this one finds it */}
        {LANGS.filter(([l]) => l !== lang).map(([l]) => (
          <button key={l} type="button" className="login-lang" lang={l} dir={l === "fa" ? "rtl" : "ltr"} onClick={() => setLang(l)}>
            <Icon name="globe" size={18} />{DICTS[l]["lang.switchTo"]}
          </button>
        ))}
      </form>
    </div>
  );
}
