import { useSlider } from "./useSlider.ts";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";
import { ClientEvent, RoomStateEvent, type MatrixEvent, type Room } from "matrix-js-sdk";
// fetched as files, not bundled as JS: separate chunks, loaded the first time the panel opens
import enUrl from "emojibase-data/en/compact.json?url";
import faUrl from "cldr-annotations-modern/annotations/fa/annotations.json?url";
import { client, emotesFor, mediaUrl, savedGifs, tintFor, toggleGif, type Emote } from "../matrix.ts";
import { usePromise, useTick } from "../hooks.ts";
import { emoteRe, isDarkMono, normalize, type Gif } from "../logic.ts";
import { confirmDialog } from "./dialog.tsx";
import { formattedPlain, previewText } from "./common.tsx";
import { Icon } from "../icons.tsx";

type Emoji = { u: string; name: string; search: string; custom?: Emote };
type Raw = { unicode: string; label: string; tags?: string[]; group?: number; order?: number };

// emojibase group ids; 2 = skin-tone/hair components
// ponytail: no skin tones (base emoji only); add a tone picker from `skins` if people ask
const GROUPS: [number, string, string][] = [
  [0, "😀", "شکلک‌ها"], [1, "👋", "آدم‌ها"], [3, "🐱", "حیوانات و طبیعت"], [4, "🍔", "خوراکی‌ها"],
  [5, "✈️", "سفر و مکان‌ها"], [6, "⚽", "فعالیت‌ها"], [7, "💡", "اشیا"], [8, "❤️", "نمادها"], [9, "🏳️", "پرچم‌ها"],
];

const IRAN = "🇮🇷", ISRAEL = "🇮🇱";
const strip = (s: string) => s.replace(/️/g, ""); // CLDR keys drop the emoji variation selector
let data: Promise<Map<number, Emoji[]>> | null = null;

function loadEmoji() {
  data ??= Promise.all([fetch(enUrl).then((r) => r.json()), fetch(faUrl).then((r) => r.json())]).then(([en, fa]: [Raw[], any]) => {
    const names = new Map<string, { default?: string[]; tts?: string[] }>();
    for (const [k, v] of Object.entries(fa.annotations.annotations)) names.set(strip(k), v as never);
    const groups = new Map<number, Emoji[]>();
    for (const e of en.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      if (e.group == null || e.group === 2 || e.unicode === ISRAEL) continue; // no group = bare regional indicators
      const f = names.get(strip(e.unicode));
      const name = f?.tts?.[0] ?? e.label;
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group)!.push({ u: e.unicode, name, search: normalize([name, ...(f?.default ?? []), e.label, ...(e.tags ?? [])].join(" ")) });
    }
    const flags = groups.get(9) ?? [], ir = flags.findIndex((e) => e.u === IRAN);
    if (ir > 0) flags.unshift(...flags.splice(ir, 1));
    return groups;
  });
  data.catch(() => { data = null; }); // retry next time the panel opens
  return data;
}

const RECENT = "panbeh.recentEmoji";
function recent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT) ?? "[]"); } catch { return []; }
}
function remember(u: string) {
  try { localStorage.setItem(RECENT, JSON.stringify([u, ...recent().filter((x) => x !== u)].slice(0, 24))); } catch { /* storage blocked */ }
}

/** `custom`: a custom emoji was picked; `e` is then its ":code:". `room`: whose packs are offered besides mine. */
/** `onBackspace`: a ⌫ beside the tabs, for the composer. */
type Props = { onEmoji: (e: string, custom?: Emote) => void; onClose: () => void; room?: Room; onBackspace?: () => void;
  gifs?: { onPick: (g: Gif) => void }; stickers?: { onPick: (s: Emote) => void } };

/** Emoji (+ optional stickers and saved gifs) popover; closes on outside click / Esc. Picking doesn't close it. */
/** docked: in the keyboard's place (Composer) — no backdrop, the chat stays scrollable and the composer closes it. */
export function EmojiPanel({ onEmoji, onClose, room, gifs, stickers, onBackspace, closing, docked }: Props & { closing?: boolean; docked?: boolean }) {
  const [tab, setTabState] = useState<"emoji" | "sticker" | "gif">("emoji");
  const pill = useSlider<HTMLDivElement>();
  // the floating tabs make way while scrolling down the grid, and come back on the way up (Telegram's)
  const [away, setAway] = useState(false);
  const lastTop = useRef(0);
  const setTab = (t: typeof tab) => { setTabState(t); setAway(false); lastTop.current = 0; };
  const onScroll = (e: UIEvent) => {
    const top = (e.target as HTMLElement).scrollTop, dy = top - lastTop.current;
    if ((e.target as HTMLElement).matches(".emoji-cats")) return; // sideways
    lastTop.current = top;
    if (top < 20 || dy < -4) setAway(false);
    else if (dy > 4) setAway(true);
  };
  const tabs = !!(gifs || stickers), bksp = !!onBackspace && tab === "emoji";
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      {!docked && <div className="menu-backdrop" onClick={onClose} />}
      <div className={"emoji-panel" + (closing ? " closing" : "") + (tabs || bksp ? " floating" : "")} role="dialog" aria-label="اموجی" onScrollCapture={onScroll}>
        {tab === "sticker" && stickers ? <StickerGrid room={room} {...stickers} />
          : tab === "gif" && gifs ? <GifGrid {...gifs} />
          : <EmojiGrid room={room} onPick={(e) => { if (e.custom) onEmoji(e.name, e.custom); else { remember(e.u); onEmoji(e.u); } }} />}
        {(tabs || bksp) && (
          <div className={"emoji-float" + (away ? " away" : "")}>
            {tabs && (
              <div className="segmented" data-pill ref={pill} role="tablist">
                <button role="tab" aria-selected={tab === "emoji"} className={tab === "emoji" ? "on" : ""} onClick={() => setTab("emoji")}>اموجی</button>
                {stickers && <button role="tab" aria-selected={tab === "sticker"} className={tab === "sticker" ? "on" : ""} onClick={() => setTab("sticker")}>استیکر</button>}
                {gifs && <button role="tab" aria-selected={tab === "gif"} className={tab === "gif" ? "on" : ""} onClick={() => setTab("gif")}>گیف</button>}
              </div>
            )}
            {bksp && <button className="emoji-bksp" aria-label="پاک کردن" title="پاک کردن" onMouseDown={(e) => e.preventDefault()} onClick={onBackspace}><Icon name="backspace" size={22} /></button>}
          </div>
        )}
      </div>
    </>
  );
}

// ponytail: recents are unicode only; custom emoji sit in their packs' tabs
function EmojiGrid({ room, onPick }: { room?: Room; onPick: (e: Emoji) => void }) {
  useTick(client, [ClientEvent.AccountData, RoomStateEvent.Events]);
  const groups = usePromise(useMemo(loadEmoji, []));
  const [rec] = useState(recent);
  const [group, setGroup] = useState<number | string>(rec.length ? -1 : 0);
  const [q, setQ] = useState("");
  const all = useMemo(() => [...(groups?.values() ?? [])].flat(), [groups]);
  const byU = useMemo(() => new Map(all.map((e) => [e.u, e])), [all]);
  const custom = new Map<string, Emoji[]>(); // pack key → its emoji
  for (const e of emotesFor(room, "emoticon")) {
    if (!custom.has(e.pack.key)) custom.set(e.pack.key, []);
    custom.get(e.pack.key)!.push({ u: e.pack.key + ":" + e.code, name: `:${e.code}:`, search: normalize(e.code), custom: e });
  }
  const term = normalize(q.trim());
  const list = !groups ? [] : term ? [...[...custom.values()].flat(), ...all].filter((e) => e.search.includes(term)).slice(0, 240)
    : group === -1 ? rec.map((u) => byU.get(u) ?? { u, name: u, search: "" })
    : typeof group === "string" ? custom.get(group) ?? [] : groups.get(group) ?? [];
  const packCats = [...custom.values()].map(([e]) => {
    const p = e.custom!.pack;
    return [p.key, <EmoteImg key={p.key} url={p.avatar ?? e.custom!.img.url} alt="" />, p.name] as const;
  });
  const nav = useRef<HTMLElement>(null);
  /** Fades the bar's edges where there's more to scroll to; RTL's scrollLeft runs negative. */
  const edges = () => {
    const n = nav.current;
    if (!n) return;
    const x = Math.abs(n.scrollLeft);
    n.toggleAttribute("data-start", x > 1);
    n.toggleAttribute("data-end", x + n.clientWidth < n.scrollWidth - 1);
  };
  useLayoutEffect(edges, [packCats.length, rec.length]);
  useEffect(() => { nav.current?.querySelector(".on")?.scrollIntoView({ inline: "nearest", block: "nearest" }); }, [group]);
  const cat = ([g, icon, label]: readonly [number | string, ReactNode, string]) => {
    const on = !term && g === group;
    return <button key={g} role="tab" aria-selected={on} className={on ? "on" : ""} title={label} aria-label={label} onClick={() => { setQ(""); setGroup(g); }}>{icon}</button>;
  };
  return (
    <>
      {/* a mouse wheel's vertical turn scrolls the bar sideways, toward its end */}
      <nav className="emoji-cats" role="tablist" ref={nav} onScroll={edges}
        onWheel={(e) => { if (!e.deltaX) nav.current?.scrollBy({ left: getComputedStyle(nav.current).direction === "rtl" ? -e.deltaY : e.deltaY }); }}>
        {rec.length > 0 && cat([-1, "🕘", "اخیر"])}
        <div className="emoji-groups">{GROUPS.map(cat)}</div>
        {packCats.map(cat)}
      </nav>
      <input className="emoji-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجوی اموجی" aria-label="جستجوی اموجی" />
      <div className="emoji-grid" key={term ? "q" : group}>
        {!groups ? <span className="spinner" />
          : !list.length ? <p className="muted">اموجی‌ای پیدا نشد</p>
          // mousedown default would move focus off the composer: keep its caret where the emoji goes
          : list.map((e) => <button key={e.u} title={e.name} aria-label={e.name} onMouseDown={(ev) => ev.preventDefault()} onClick={() => onPick(e)}>
            {e.custom ? <EmoteImg url={e.custom.img.url} alt={e.name} /> : e.u}</button>)}
      </div>
    </>
  );
}

const looks = new Map<string, Promise<boolean>>(); // mxc → isDarkMono, read once

/** Whether a custom emoji (`src`: its blob URL) takes the text color: its pack's say, else how it looks (an animated one's first frame). */
export function tinted(mxc: string, src: string): Promise<boolean> {
  const t = tintFor(mxc);
  if (t !== "auto") return Promise.resolve(t === "always");
  let p = looks.get(mxc);
  if (!p) {
    p = fetch(src).then((r) => r.blob()).then((b) => createImageBitmap(b)).then((bmp) => {
      const k = Math.min(1, 64 / Math.max(bmp.width, bmp.height)); // enough pixels to judge
      const cv = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
      const g = cv.getContext("2d")!;
      g.drawImage(bmp, 0, 0, cv.width, cv.height);
      bmp.close();
      return isDarkMono(g.getImageData(0, 0, cv.width, cv.height).data);
    }).catch(() => false);
    looks.set(mxc, p);
  }
  return p;
}

/** A custom emoji or sticker: the whole file, not a server thumbnail, so animated ones play. `sticker`: never tinted. */
export function EmoteImg({ url, alt, className = "emote", sticker }: { url: string; alt: string; className?: string; sticker?: boolean }) {
  const src = usePromise(mediaUrl({ url }));
  const tint = usePromise(useMemo(() => (src ? (sticker ? Promise.resolve(false) : tinted(url, src)) : null), [url, src, sticker, tintFor(url)]));
  // held back until the tint is known, so a black emoji doesn't flash before it turns white
  return src && tint !== undefined
    ? <img className={className + (tint ? " tint" : "")} style={tint ? { "--src": `url("${src}")` } as never : undefined} src={src} alt={alt} title={alt || undefined} draggable={false} />
    : <span className={className + " shimmer"} />;
}

/** Text with its ":code:"s for `emotes` (code → mxc) shown as the emoji. */
export function EmoteText({ text, emotes }: { text: string; emotes?: ReadonlyMap<string, string> }) {
  const re = emotes?.size ? emoteRe(emotes.keys()) : null;
  if (!re) return <>{text}</>;
  return <>{text.split(re).map((p, i) => (i % 2 ? <EmoteImg key={i} url={emotes!.get(p)!} alt={`:${p}:`} /> : p))}</>;
}

/** previewText with the message's custom emoji as images (reply quotes, the composer's reply bar). */
export function PreviewText({ ev }: { ev: MatrixEvent }) {
  return <EmoteText text={previewText(ev)} emotes={formattedPlain(ev.getContent())?.emotes} />;
}

/** A reaction's key: a custom emoji's is its mxc, named by com.beeper.reaction.shortcode on the reaction `ev`. */
export function ReactionKey({ k, ev }: { k: string; ev?: MatrixEvent }) {
  if (!k.startsWith("mxc://")) return <>{k}</>;
  return <EmoteImg url={k} alt={String(ev?.getContent()["com.beeper.reaction.shortcode"] ?? "")} />;
}

function StickerGrid({ room, onPick }: { room?: Room; onPick: (s: Emote) => void }) {
  useTick(client, [ClientEvent.AccountData, RoomStateEvent.Events]);
  const list = emotesFor(room, "sticker");
  if (!list.length) return <p className="muted">استیکری ندارید. در تنظیمات ← اموجی و استیکر بسازید یا استیکر دیگران را ذخیره کنید.</p>;
  return (
    <div className="gif-grid sticker-grid">
      {list.map((s, i) => (
        <Fragment key={s.pack.key + ":" + s.code}>
          {s.pack !== list[i - 1]?.pack && <h4>{s.pack.name}</h4>}
          <button title={`:${s.code}:`} aria-label={s.img.body || s.code} onClick={() => onPick(s)}><EmoteImg url={s.img.url} alt="" className="" sticker /></button>
        </Fragment>
      ))}
    </div>
  );
}

// ---------- saved gifs (account data, see matrix.ts) ----------

function GifGrid({ onPick }: { onPick: (g: Gif) => void }) {
  useTick(client, [ClientEvent.AccountData]);
  const gifs = savedGifs();
  if (!gifs.length) return <p className="muted">گیفی ندارید. ویدیو را با گزینه‌ی «ارسال به صورت گیف» بفرستید یا گیف دیگران را ذخیره کنید.</p>;
  const remove = (g: Gif) => confirmDialog("این گیف از گیف‌های شما حذف شود؟", { danger: true }).then((y) => { if (y) void toggleGif(g); });
  return (
    <div className="gif-grid">
      {gifs.map((g) => (
        <button key={g.url ?? g.file?.url} aria-label="گیف" onClick={() => onPick(g)}
          onContextMenu={(e) => { e.preventDefault(); void remove(g); }}><GifView c={g} /></button>
      ))}
    </div>
  );
}

/** A gif in a message or the gif tab: plays by itself, looped and muted. `onSize`: its real pixel size, once known. */
export function GifView({ c, onSize }: { c: Gif; onSize?: (w: number, h: number) => void }) {
  const src = usePromise(mediaUrl(c as never)); // file carries the full IEncryptedFile; Gif only names its url
  if (!src) return <span className="shimmer" />;
  return c.msgtype === "m.image"
    ? <img src={src} alt="" draggable={false} onLoad={(e) => onSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
    : <video src={src} autoPlay loop muted playsInline disablePictureInPicture onLoadedMetadata={(e) => onSize?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />;
}
