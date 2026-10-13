import { useSlider } from "./useSlider.ts";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ClientEvent, RoomStateEvent, type MatrixEvent, type Room } from "matrix-js-sdk";
// fetched as files, not bundled as JS: separate chunks, loaded the first time the panel opens
import enUrl from "emojibase-data/en/compact.json?url";
import faUrl from "cldr-annotations-modern/annotations/fa/annotations.json?url";
import { client, emotesFor, mediaUrl, savedGifs, toggleGif, type Emote } from "../matrix.ts";
import { usePromise, useTick } from "../hooks.ts";
import { normalize, type Gif } from "../logic.ts";
import { confirmDialog } from "./dialog.tsx";

type Emoji = { u: string; name: string; search: string; custom?: Emote };
type Raw = { unicode: string; label: string; tags?: string[]; group?: number; order?: number };

// emojibase group ids; 2 = skin-tone/hair components
// ponytail: no skin tones (base emoji only); add a tone picker from `skins` if people ask
const GROUPS: [number, string, string][] = [
  [0, "😀", "شکلک‌ها"], [1, "👋", "آدم‌ها"], [3, "🐱", "حیوانات و طبیعت"], [4, "🍔", "خوراکی‌ها"],
  [5, "✈️", "سفر و مکان‌ها"], [6, "⚽", "فعالیت‌ها"], [7, "💡", "اشیا"], [8, "❤️", "نمادها"], [9, "🏳️", "پرچم‌ها"],
];

const strip = (s: string) => s.replace(/️/g, ""); // CLDR keys drop the emoji variation selector
let data: Promise<Map<number, Emoji[]>> | null = null;

function loadEmoji() {
  data ??= Promise.all([fetch(enUrl).then((r) => r.json()), fetch(faUrl).then((r) => r.json())]).then(([en, fa]: [Raw[], any]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const names = new Map<string, { default?: string[]; tts?: string[] }>();
    for (const [k, v] of Object.entries(fa.annotations.annotations)) names.set(strip(k), v as never);
    const groups = new Map<number, Emoji[]>();
    for (const e of en.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      if (e.group == null || e.group === 2) continue; // no group = bare regional indicators
      const f = names.get(strip(e.unicode));
      const name = f?.tts?.[0] ?? e.label;
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group)!.push({ u: e.unicode, name, search: normalize([name, ...(f?.default ?? []), e.label, ...(e.tags ?? [])].join(" ")) });
    }
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
type Props = { onEmoji: (e: string, custom?: Emote) => void; onClose: () => void; room?: Room;
  gifs?: { onPick: (g: Gif) => void }; stickers?: { onPick: (s: Emote) => void } };

/** Emoji (+ optional stickers and saved gifs) popover; closes on outside click / Esc. Picking doesn't close it. */
export function EmojiPanel({ onEmoji, onClose, room, gifs, stickers, closing }: Props & { closing?: boolean }) {
  const [tab, setTab] = useState<"emoji" | "sticker" | "gif">("emoji");
  const pill = useSlider<HTMLDivElement>();
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className={"emoji-panel" + (closing ? " closing" : "")} role="dialog" aria-label="اموجی">
        {(gifs || stickers) && (
          <div className="segmented" data-pill ref={pill}>
            <button className={tab === "emoji" ? "on" : ""} onClick={() => setTab("emoji")}>اموجی</button>
            {stickers && <button className={tab === "sticker" ? "on" : ""} onClick={() => setTab("sticker")}>استیکر</button>}
            {gifs && <button className={tab === "gif" ? "on" : ""} onClick={() => setTab("gif")}>گیف</button>}
          </div>
        )}
        {tab === "sticker" && stickers ? <StickerGrid room={room} {...stickers} />
          : tab === "gif" && gifs ? <GifGrid {...gifs} />
          : <EmojiGrid room={room} onPick={(e) => { if (e.custom) onEmoji(e.name, e.custom); else { remember(e.u); onEmoji(e.u); } }} />}
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
  const cats: (readonly [number | string, ReactNode, string])[] = [...(rec.length ? [[-1, "🕘", "اخیر"] as const] : []), ...packCats, ...GROUPS];
  return (
    <>
      <input className="emoji-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجوی اموجی" aria-label="جستجوی اموجی" />
      {!term && (
        <nav className="emoji-cats" role="tablist">
          {cats.map(([g, icon, label]) => (
            <button key={g} role="tab" aria-selected={g === group} className={g === group ? "on" : ""} title={label} aria-label={label} onClick={() => setGroup(g)}>{icon}</button>
          ))}
        </nav>
      )}
      <div className="emoji-grid">
        {!groups ? <span className="spinner" />
          : !list.length ? <p className="muted">اموجی‌ای پیدا نشد</p>
          // mousedown default would move focus off the composer: keep its caret where the emoji goes
          : list.map((e) => <button key={e.u} title={e.name} aria-label={e.name} onMouseDown={(ev) => ev.preventDefault()} onClick={() => onPick(e)}>
            {e.custom ? <EmoteImg url={e.custom.img.url} alt={e.name} /> : e.u}</button>)}
      </div>
    </>
  );
}

/** A custom emoji or sticker: the whole file, not a server thumbnail, so animated ones play. */
export function EmoteImg({ url, alt, className = "emote" }: { url: string; alt: string; className?: string }) {
  const src = usePromise(mediaUrl({ url }));
  return src ? <img className={className} src={src} alt={alt} title={alt || undefined} draggable={false} /> : <span className={className + " shimmer"} />;
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
          <button title={`:${s.code}:`} aria-label={s.img.body || s.code} onClick={() => onPick(s)}><EmoteImg url={s.img.url} alt="" className="" /></button>
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
