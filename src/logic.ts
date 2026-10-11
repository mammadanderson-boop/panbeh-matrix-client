// Pure helpers — no SDK imports so `node --test` can run them directly.

export type Msg = { id: string; sender: string; ts: number; kind: "msg" | "notice" };
export type Row =
  | { type: "day"; key: string; label: string }
  | { type: "notice"; key: string; id: string }
  | { type: "unread"; key: "unread" }
  | { type: "msg"; key: string; id: string; first: boolean; last: boolean };

const LOCALE = "fa-IR"; // Jalali calendar + Persian digits
// formatters built once: toLocale*String builds a new one per call, which made every message re-render slow
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, o);
const NUM = new Intl.NumberFormat(LOCALE), TIME = fmt({ hour: "2-digit", minute: "2-digit" }), YEAR = fmt({ year: "numeric" }),
  DAY_MONTH = fmt({ month: "long", day: "numeric" }), DAY_MONTH_YEAR = fmt({ month: "long", day: "numeric", year: "numeric" }),
  WEEKDAY = fmt({ weekday: "short" }), SHORT_DATE = fmt({ day: "numeric", month: "short" });
export const num = (n: number) => NUM.format(n);

const GROUP_GAP = 5 * 60_000;
const day = (ts: number) => new Date(ts).toDateString();
const groups = (a: Msg | undefined, b: Msg | undefined) =>
  !!a && !!b && a.kind === "msg" && b.kind === "msg" &&
  a.sender === b.sender && b.ts - a.ts < GROUP_GAP && day(a.ts) === day(b.ts);

/** Timeline rows: day separators + messages flagged as first/last of a same-sender burst,
 *  plus an "unread" divider after `unreadAfter` (a Msg id) when anything follows it. */
export function buildRows(msgs: Msg[], now = Date.now(), unreadAfter?: string): Row[] {
  const rows: Row[] = [];
  let prevDay = "";
  msgs.forEach((m, i) => {
    if (day(m.ts) !== prevDay) {
      prevDay = day(m.ts);
      rows.push({ type: "day", key: "day-" + prevDay, label: dayLabel(m.ts, now) });
    }
    if (m.kind === "notice") rows.push({ type: "notice", key: m.id, id: m.id });
    // the divider splits a burst
    else rows.push({ type: "msg", key: m.id, id: m.id, first: !groups(msgs[i - 1], m) || msgs[i - 1].id === unreadAfter, last: !groups(m, msgs[i + 1]) || m.id === unreadAfter });
    if (m.id === unreadAfter && i < msgs.length - 1) rows.push({ type: "unread", key: "unread" });
  });
  return rows;
}

export function dayLabel(ts: number, now = Date.now()) {
  const d = new Date(ts), n = new Date(now);
  const diff = Math.round((new Date(n.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (diff === 0) return "امروز";
  if (diff === 1) return "دیروز";
  // Jalali years roll over at Nowruz, not Jan 1, so compare them in that calendar
  return (YEAR.format(d) === YEAR.format(n) ? DAY_MONTH : DAY_MONTH_YEAR).format(d);
}

/** Chat-list timestamp: 14:05 today, "Mon" this week, "12 Mar" otherwise. */
export function listTime(ts: number, now = Date.now()) {
  if (!(ts > 0)) return "";
  const d = new Date(ts);
  if (day(ts) === day(now)) return TIME.format(d);
  if (now - ts < 6 * 86_400_000) return WEEKDAY.format(d);
  return SHORT_DATE.format(d);
}

export const clock = (ts: number) => TIME.format(ts);

export type RoomInfo = {
  id: string; isDM: boolean; unread: number; spaces: string[];
  marked?: boolean; archived?: boolean; muted?: boolean; // marked = "mark as unread"
};
export type Folder = { id: string; label: string };

export const BASE_FOLDERS: Folder[] = [
  { id: "all", label: "همه" },
  { id: "unread", label: "خوانده‌نشده" },
  { id: "dms", label: "شخصی" },
  { id: "groups", label: "گروه‌ها" },
];

/** Folders in the user's saved order. "all" always leads; folders the order doesn't know (a newly joined space)
 *  follow in their default order, and ids that no longer exist are ignored. */
export function applyFolderOrder(folders: Folder[], order: string[]): Folder[] {
  const rank = new Map(order.map((id, i) => [id, i] as const));
  const rest = folders.filter((f) => f.id !== "all");
  const known = rest.filter((f) => rank.has(f.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...folders.filter((f) => f.id === "all"), ...known, ...rest.filter((f) => !rank.has(f.id))];
}

/** `ids` with the one at `from` moved to `to`. The first (the "all" tab) neither moves nor gets displaced. */
export function moveFolder(ids: string[], from: number, to: number): string[] {
  if (from < 1 || to < 1 || from >= ids.length || to >= ids.length || from === to) return ids;
  const next = ids.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Archived chats live in the "archive" pseudo-folder and nowhere else. */
export function inFolder(r: RoomInfo, folder: string) {
  if ((folder === "archive") !== inArchive(r)) return false;
  switch (folder) {
    case "all": case "archive": return true;
    case "unread": return isUnread(r);
    case "dms": return r.isDM;
    case "groups": return !r.isDM;
    default: return r.spaces.includes(folder); // space id
  }
}

/** All rooms reachable from a space, following sub-spaces (cycle-safe). */
export function spaceRooms(spaceId: string, children: (id: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const walk = (id: string) => children(id).forEach((c) => { if (!seen.has(c)) { seen.add(c); walk(c); } });
  walk(spaceId);
  return seen;
}

export function normalizeServer(input: string) {
  const s = input.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(s) ? s : "https://" + s;
}

/** Full Matrix user ID, e.g. "@alice:example.org" (worth a direct profile lookup). */
export const isUserId = (s: string) => /^@[^\s:]+:[^\s:]+(:\d+)?$/.test(s.trim());

/** The SDK's RoomNameState, structurally (count includes us). */
type NameState = { name: string } | { names: string[]; count: number; subtype?: "Inviting" } | { oldName?: string };

/** Farsi room names for the SDK's roomNameGenerator; null keeps an actual name. `inviter` names an invite with no members known. */
export function roomName(s: NameState, inviter?: string): string | null {
  if ("name" in s) return null;
  if ("names" in s && s.names.length) {
    const [a, b] = s.names, others = s.count - 1;
    const names = s.names.length === 1 && others <= 1 ? a
      : s.names.length === 2 && others <= 2 ? `${a} و ${b}`
      : `${a} و ${num(others - 1)} نفر دیگر`;
    return s.subtype === "Inviting" ? `در حال دعوت از ${names}` : names;
  }
  const old = "oldName" in s && s.oldName;
  return inviter ?? (old ? `گفتگوی خالی (قبلاً ${old})` : "گفتگوی خالی");
}

/** Suggested #address localpart from a room name; Latin letters/digits only (Farsi names give ""). */
export const aliasLocalpart = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** "امروز، ۱۴:۰۵" — day plus time, for read receipts. */
/** Search-term folding: case, Arabic/Persian ي ك, and ZWNJ don't matter. */
export const normalize = (s: string) => s.toLowerCase().replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\u200c/g, "");

/** Where `term` matches `text` (both normalized), as [start, end) in the original text: normalizing drops ZWNJs, which shifts indices. */
export function matchRange(text: string, term: string): [number, number] | null {
  const t = normalize(term);
  if (!t) return null;
  let norm = "";
  const at: number[] = []; // index in `text` of each char of `norm`
  for (let i = 0; i < text.length; i++) {
    const n = normalize(text[i]);
    norm += n;
    for (let k = 0; k < n.length; k++) at.push(i);
  }
  const i = norm.indexOf(t);
  return i < 0 ? null : [at[i], at[i + t.length - 1] + 1];
}

export const stamp = (ts: number, now = Date.now()) => `${dayLabel(ts, now)}، ${clock(ts)}`;

/** Telegram-style last seen from m.presence; null when the server told us nothing. */
export function lastSeen(online: boolean, activeTs: number | undefined, now = Date.now()) {
  if (online) return "آنلاین";
  if (!activeTs || activeTs <= 0) return null;
  const min = Math.floor((now - activeTs) / 60_000);
  if (min < 1) return "چند لحظه پیش";
  if (min < 60) return `آخرین بازدید ${num(min)} دقیقه پیش`;
  return `آخرین بازدید ${day(activeTs) === day(now) ? "امروز" : dayLabel(activeTs, now)}، ${clock(activeTs)}`;
}

/** "۱:۰۵" from milliseconds. */
export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${num(Math.floor(s / 60))}:${num(s % 60).padStart(2, "۰")}`;
}

/** `n` bars (peak of each slice), scaled 0..1024 like MSC1767 waveforms. Also rescales a received waveform for display. */
export function downsample(xs: number[], n = 40) {
  if (!xs.length) return [];
  const max = Math.max(...xs) || 1;
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * xs.length) / n);
    const part = xs.slice(a, Math.max(a + 1, Math.floor(((i + 1) * xs.length) / n)));
    return Math.round((Math.max(...part) / max) * 1024);
  });
}

/** geo:lat,lon[,alt][;u=accuracy] → numbers; null if malformed. */
export function parseGeoUri(uri: unknown) {
  const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,-?[\d.]+)?(?:;.*?\bu=(\d+(?:\.\d+)?))?/i.exec(typeof uri === "string" ? uri : "");
  return m ? { lat: +m[1], lon: +m[2], acc: m[3] ? +m[3] : undefined } : null;
}

export const osmUrl = (lat: number, lon: number) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;

export type Vote = { sender: string; ts: number; answers: unknown };

/** Poll results from response events: each voter's latest vote counts. Per MSC3381 a vote with an unknown
 *  or no answer is spoiled (and still replaces that voter's earlier vote); answers past `max` are dropped. */
export function tallyPoll(votes: Vote[], answerIds: string[], max: number) {
  const latest = new Map<string, Vote>();
  for (const v of votes) if (!((latest.get(v.sender)?.ts ?? -Infinity) > v.ts)) latest.set(v.sender, v);
  const voters = new Map<string, string[]>(answerIds.map((id) => [id, []]));
  const picks = new Map<string, string[]>();
  for (const [sender, v] of latest) {
    const a = [...new Set(Array.isArray(v.answers) ? v.answers.slice(0, Math.max(1, max)) : [])];
    if (!a.length || a.some((id) => !voters.has(id))) continue;
    picks.set(sender, a);
    a.forEach((id) => voters.get(id)!.push(sender));
  }
  return { voters, picks };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Telegram-style Markdown subset + "@Name" mentions as matrix.to links. Everything that must not be
 *  re-parsed (code, links, mentions) is stashed behind \0N\0 placeholders until the end.
 *  null when nothing got formatted, so plain messages send no formatted_body. */
export function formatMessage(text: string, mentions: { name: string; id: string }[]): { html: string; ids: string[] } | null {
  const stash: string[] = [];
  const hold = (html: string) => `\0${stash.push(html) - 1}\0`;
  let t = text.replaceAll("\0", "");
  t = t.replace(/\n?```(?:[\w+-]*\n)?([\s\S]*?)\n?```\n?/g, (_, c) => hold(`<pre><code>${esc(c)}</code></pre>`));
  t = t.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));

  const byName = new Map(mentions.map((m) => ["@" + m.name, m.id]));
  const used = new Set<string>();
  if (byName.size) {
    // longest first so "@Ali Reza" isn't cut short by "@Ali"
    const re = new RegExp([...byName.keys()].sort((a, b) => b.length - a.length).map(escRe).join("|"), "g");
    t = t.replace(re, (m) => {
      const id = byName.get(m)!;
      used.add(id);
      return hold(`<a href="https://matrix.to/#/${esc(id)}">${esc(m.slice(1))}</a>`);
    });
  }

  t = esc(t);
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => hold(`<a href="${url}">${label}</a>`));
  const parts: { html: string; quote: boolean }[] = [];
  for (const line of t.split("\n")) {
    const q = line.startsWith("&#62; ");
    const last = parts[parts.length - 1];
    if (q && last?.quote) last.html += "<br>" + line.slice(6);
    else parts.push({ html: q ? line.slice(6) : line, quote: q });
  }
  let h = parts.map((p, i) => (p.quote ? `<blockquote>${p.html}</blockquote>` : p.html) + (i < parts.length - 1 && !p.quote && !parts[i + 1].quote ? "\n" : "")).join("");
  const wrap = (re: RegExp, open: string, close: string) => (h = h.replace(re, `${open}$1${close}`));
  wrap(/\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*/g, "<strong>", "</strong>");
  wrap(/~~([^\s~](?:[^~\n]*?[^\s~])?)~~/g, "<del>", "</del>");
  wrap(/\|\|([^\s|](?:[^|\n]*?[^\s|])?)\|\|/g, "<span data-mx-spoiler>", "</span>");
  // opening marker not after a word char, closing not before one: snake_case and 2*3*4 stay literal
  h = h.replace(/(?<![\p{L}\p{N}_*])([*_])(?=\S)((?:(?!\1)[^\n])*?\S)\1(?![\p{L}\p{N}_*])/gu, "<em>$2</em>");
  h = h.replace(/\n/g, "<br>"); // before restoring, so <pre> keeps its newlines
  while (h.includes("\0")) h = h.replace(/\0(\d+)\0/g, (_, n) => stash[+n]);
  const clean = esc(text.replaceAll("\0", "")).replace(/\n/g, "<br>");
  return used.size || h !== clean ? { html: h, ids: [...used] } : null;
}

const TLDS = "com|org|net|edu|gov|int|io|ir|co|me|app|dev|info|biz|ai|tv|xyz|ly|gl|us|uk|de|fr|ru|tech|online|site|chat|link|page";
/** What counts as a web link in plain text: http(s)://…, www.…, or a bare domain with a well-known TLD (not in emails). */
export const LINK_SRC =
  "(?:https?:\\/\\/|www\\.)[^\\s<]+[^\\s<.,;:!?)\"'`]" +
  "|(?<![\\w@.\\/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:" + TLDS + ")(?![\\w@-])(?::\\d+)?(?:\\/[^\\s<]*[^\\s<.,;:!?)\"'`])?";
/** href for a link found by LINK_SRC: scheme-less ones get https://. */
export const linkHref = (u: string) => (/^(?:https?:|matrix:)/i.test(u) ? u : "https://" + u);
/** Distinct web links in text (same pattern as the bubble's linkify), as hrefs. */
export const extractLinks = (text: string) => [...new Set((text.match(new RegExp(LINK_SRC, "gi")) ?? []).map(linkHref))];
/** Links in a message's own text, not in the quoted reply fallback. */
export const contentLinks = (c: Record<string, unknown>) => extractLinks(String(c.body ?? "").replace(/^(> .*\n)+\n?/, ""));

export type MediaKind = "media" | "file" | "link" | "audio";
/** Shared-media tab for an event; null = not listed (stickers, polls, plain text…). */
export function mediaKind(type: string, c: Record<string, unknown>): MediaKind | null {
  if (type !== "m.room.message") return null;
  switch (c.msgtype) {
    case "m.image": case "m.video": return "media";
    case "m.file": return "file";
    case "m.audio": return "audio";
    case "m.text": case "m.notice": case "m.emote": return contentLinks(c).length ? "link" : null;
  }
  return null;
}
export const isUnread = (r: RoomInfo) => r.unread > 0 || !!r.marked;

/** Telegram-style: an unmuted archived chat with new messages shows in the main list until it's read again. */
export const inArchive = (r: RoomInfo) => !!r.archived && !(r.unread > 0 && !r.muted);

/** Chat list order: invites, then pinned, then newest. */
export const byListOrder = (a: { invite: boolean; pinned?: boolean; ts: number }, b: typeof a) =>
  +b.invite - +a.invite || +!!b.pinned - +!!a.pinned || b.ts - a.ts;
/** A looping, silent video (mautrix's flags, also set by the Telegram bridge) or an animated gif image. */
export const isGif = (c: { msgtype?: string; info?: Record<string, unknown> }) =>
  !!c.info?.["fi.mau.gif"] || (c.msgtype === "m.image" && c.info?.mimetype === "image/gif");

export type Gif = { msgtype: string; body: string; info?: Record<string, unknown>; url?: string; file?: { url: string } };
const gifKey = (g: Gif) => g.url ?? g.file?.url;
// ponytail: capped at 100, account data tops out around 64KB
/** Saved gifs with `g` first: re-saving moves it up instead of duplicating. */
export const withGif = (list: Gif[], g: Gif) => [g, ...list.filter((x) => gifKey(x) !== gifKey(g))].slice(0, 100);
export const withoutGif = (list: Gif[], g: Gif) => list.filter((x) => gifKey(x) !== gifKey(g));
export const hasGif = (list: Gif[], g: Gif) => list.some((x) => gifKey(x) === gifKey(g));

// ---------- room admin ----------

/** "مدیر" / "ناظر" / "سطح ۲۵"; null for plain members. */
// Infinity = a room v12 creator, who outranks everyone
export const roleLabel = (level: number) => (level === Infinity ? "مالک" : level >= 100 ? "مدیر" : level >= 50 ? "ناظر" : level > 0 ? `سطح ${num(level)}` : null);

export type PowerLevels = {
  users?: Record<string, number>; users_default?: number; events?: Record<string, number>; events_default?: number; state_default?: number;
  invite?: number; kick?: number; ban?: number; redact?: number; notifications?: Record<string, number>;
};
const PL_DEFAULTS: Record<string, number> = { invite: 0, kick: 50, ban: 50, redact: 50, events_default: 0, state_default: 50 };

/** A power-level setting by key, with the spec's defaults: "kick", "notifications.room", "events.<state type>" (falls back
 *  to state_default). "events_default" means sending messages, so an m.room.message override wins over it. */
export function levelAt(pl: PowerLevels, key: string): number {
  if (key.startsWith("events.")) return pl.events?.[key.slice(7)] ?? pl.state_default ?? 50;
  if (key.startsWith("notifications.")) return pl.notifications?.[key.slice(14)] ?? 50;
  if (key === "events_default") return pl.events?.["m.room.message"] ?? pl.events_default ?? 0;
  return (pl as Record<string, number | undefined>)[key] ?? PL_DEFAULTS[key] ?? 50;
}

/** New m.room.power_levels content with one setting changed (keys as in levelAt). */
export function withLevel(pl: PowerLevels, key: string, level: number): PowerLevels {
  if (key.startsWith("events.")) return { ...pl, events: { ...pl.events, [key.slice(7)]: level } };
  if (key.startsWith("notifications.")) return { ...pl, notifications: { ...pl.notifications, [key.slice(14)]: level } };
  if (key === "events_default") {
    const { ["m.room.message"]: _, ...events } = pl.events ?? {};
    return { ...pl, events_default: level, events };
  }
  return { ...pl, [key]: level };
}

/** Select options for a level: the presets I may grant, plus the current value if it's a custom one. */
export function levelOptions(presets: [number, string][], mine: number, current: number): [number, string][] {
  const o = presets.filter(([l]) => l <= mine || l === current);
  if (!o.some(([l]) => l === current)) o.push([current, current === Infinity ? "مالک" : current > 0 ? `سطح ${num(current)}` : "عضو"]);
  return o.sort((a, b) => a[0] - b[0]);
}

/** Room version features; unknown or non-numeric (experimental) versions count as unsupported. */
const versionAtLeast = (version: string | undefined, n: number) => /^\d+$/.test(version ?? "") && Number(version) >= n;
export const supportsKnock = (version: string | undefined) => versionAtLeast(version, 7);
export const supportsRestricted = (version: string | undefined) => versionAtLeast(version, 8);
export const supportsKnockRestricted = (version: string | undefined) => versionAtLeast(version, 10);

/** The server's default room version when the room should move to it: an older number, or a version the server marks
 *  unstable or doesn't know. Null when it's fine (or the server didn't say). */
export function upgradeTarget(version: string, rv?: { default: string; available: Record<string, string> }): string | null {
  if (!rv?.default || version === rv.default) return null;
  if (versionAtLeast(version, 0) && versionAtLeast(rv.default, 0)) return Number(version) < Number(rv.default) ? rv.default : null;
  return rv.available[version] !== "stable" ? rv.default : null;
}

export const JOIN_RULES: Record<string, string> = {
  public: "عمومی؛ هر کسی می‌تواند بپیوندد", invite: "خصوصی؛ فقط با دعوت", knock: "با درخواست عضویت",
  restricted: "اعضای فضا", knock_restricted: "اعضای فضا، یا با درخواست عضویت",
};
export const HISTORY: Record<string, string> = { shared: "اعضا، از ابتدا", invited: "اعضا، از زمان دعوت", joined: "اعضا، از زمان پیوستن", world_readable: "همه، حتی بدون عضویت" };

const ERRORS: Record<string, string> = {
  M_FORBIDDEN: "اجازه‌ی این کار را ندارید.",
  M_ROOM_IN_USE: "این نشانی قبلاً گرفته شده است.",
  M_EXCLUSIVE: "این نشانی برای سرویس دیگری (مثل پل ارتباطی) رزرو شده است.",
  M_UNSUPPORTED_ROOM_VERSION: "سرور از این نسخه‌ی گفتگو پشتیبانی نمی‌کند.",
  M_TOO_LARGE: "حجم آن برای سرور زیاد است.",
  M_RESOURCE_LIMIT_EXCEEDED: "سرور به سقف منابع خود رسیده است؛ با مدیر سرور تماس بگیرید.",
  M_NOT_FOUND: "پیدا نشد.",
  M_UNKNOWN_TOKEN: "نشست شما منقضی شده است؛ دوباره وارد شوید.",
  M_CANNOT_LEAVE_SERVER_NOTICE_ROOM: "نمی‌توان از گفتگوی اطلاعیه‌های سرور خارج شد.",
  M_GUEST_ACCESS_FORBIDDEN: "مهمان‌ها به این گفتگو دسترسی ندارند.",
};

/** Persian text for a Matrix error code; undefined = show the server's own message. */
export function errorText(errcode: string | undefined, data?: { retry_after_ms?: number }): string | undefined {
  if (errcode === "M_LIMIT_EXCEEDED") {
    const s = Math.ceil((data?.retry_after_ms ?? 0) / 1000);
    return "درخواست‌ها زیاد بود" + (s > 0 ? `؛ ${num(s)} ثانیه‌ی دیگر دوباره امتحان کنید.` : "؛ کمی بعد دوباره امتحان کنید.");
  }
  return errcode ? ERRORS[errcode] : undefined;
}

type Levels = { users?: Record<string, number>; users_default?: number };
/** Users whose power level differs between two m.room.power_levels contents (missing = users_default). */
export function levelChanges(prev: Levels, next: Levels) {
  const at = (c: Levels, id: string) => c.users?.[id] ?? c.users_default ?? 0;
  const ids = new Set([...Object.keys(prev.users ?? {}), ...Object.keys(next.users ?? {})]);
  return [...ids].filter((id) => at(prev, id) !== at(next, id)).map((id) => ({ id, from: at(prev, id), to: at(next, id) }));
}

/** Scale (w, h) so the longer side is at most `max`; never upscales. */
export function fitSize(w: number, h: number, max = 1280) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

/** Direction of a message's text the way dir=auto picks it (first letter), but the same everywhere: WebViews disagree on text
 *  with no letters (numbers, emoji), and the time/ticks have to sit on the side the text leaves free. */
export function textDir(s: string): "rtl" | "ltr" {
  const letter = /\p{L}/u.exec(s)?.[0];
  return letter && /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u.test(letter) ? "rtl" : "ltr";
}

type RingContent = { notification_type?: string; "m.mentions"?: { room?: boolean; user_ids?: string[] } };
/** An m.rtc.notification (MSC4075) that should ring `me` now: a "ring" (not a group "notification"), aimed at us or the room, before `until`. */
const aimedAt = (c: RingContent, me: string) => !!(c["m.mentions"]?.room || c["m.mentions"]?.user_ids?.includes(me));
export const isRing = (c: RingContent, until: number, me: string, now = Date.now()) =>
  c.notification_type === "ring" && aimedAt(c, me) && until > now; // NaN until = no
/** A group call that just started (a "notification", not a ring): worth a quiet notification. */
export const isGroupCallAlert = (c: RingContent, until: number, me: string, now = Date.now()) =>
  c.notification_type === "notification" && aimedAt(c, me) && until > now;

type Invite = { lifetime?: number; invitee?: string; offer?: { sdp?: string } };
/** A legacy 1:1 m.call.invite (old Element, FluffyChat, Nheko…) that should ring `me` now: unexpired and not aimed at someone else. */
export const isLegacyRing = (c: Invite, ts: number, me: string, now = Date.now()) =>
  ts + (c.lifetime ?? 0) > now && (!c.invitee || c.invitee === me);
export const isVideoOffer = (c: Invite) => /^m=video/m.test(c.offer?.sdp ?? "");

// ---------- how a call went (for its line in the timeline) ----------

export type CallEv = { id?: string; type: string; sender: string; ts: number; content: Record<string, any> };
/** ringing/ongoing: nothing to add yet. ended: answered, for `duration` ms. */
export type CallOutcome = { state: "ringing" | "ongoing" | "missed" | "declined" | "ended"; duration?: number };
const MEMBER = "org.matrix.msc3401.call.member";
const isEmpty = (c: object | undefined) => !c || !Object.keys(c).length;

/** A legacy m.call.invite, from the events after it in the room (oldest first). */
export function legacyOutcome(invite: CallEv, after: CallEv[], now = Date.now()): CallOutcome {
  const same = after.filter((e) => e.content?.call_id === invite.content.call_id);
  const answer = same.find((e) => e.type === "m.call.answer");
  const end = same.find((e) => e.type === "m.call.hangup" || e.type === "m.call.reject");
  if (answer) return end ? { state: "ended", duration: end.ts - answer.ts } : { state: "ongoing" };
  if (end?.type === "m.call.reject") return { state: "declined" };
  return end || invite.ts + (invite.content.lifetime ?? 0) <= now ? { state: "missed" } : { state: "ringing" };
}

/** A MatrixRTC ring (m.rtc.notification) ringing until `until`: answered once someone else's call membership shows up, over when one side leaves. */
export function rtcOutcome(ring: CallEv, until: number, after: CallEv[], now = Date.now()): CallOutcome {
  const members = after.filter((e) => e.type === MEMBER);
  const joined = members.find((e) => e.sender !== ring.sender && !isEmpty(e.content) && e.ts <= until);
  if (joined) {
    const left = members.find((e) => e.ts >= joined.ts && isEmpty(e.content)); // 1:1: whoever leaves first ends it
    return left ? { state: "ended", duration: left.ts - joined.ts } : { state: "ongoing" };
  }
  if (after.some((e) => e.type.endsWith("rtc.decline") && e.content?.["m.relates_to"]?.event_id === ring.id)) return { state: "declined" };
  const gaveUp = members.some((e) => e.sender === ring.sender && isEmpty(e.content));
  return gaveUp || until <= now ? { state: "missed" } : { state: "ringing" };
}

// ---------- call stats (the overlay on each feed) ----------

/** One feed's numbers; bytes/ts carry over to the next sample for the bitrate. loss in %, rtt in ms. */
export type Stats = { w?: number; h?: number; fps?: number; kbps?: number; loss?: number; rtt?: number; codec?: string; bytes: number; ts: number };

/**
 * A WebRTC stats report (its values) → one feed's numbers: received (in) or sent (out). Video wins over audio; simulcast layers add up.
 * prev: the last sample, for the bitrate.
 */
export function parseStats(entries: Iterable<Record<string, any>>, dir: "in" | "out", prev?: Stats): Stats {
  const all = [...entries], type = dir === "in" ? "inbound-rtp" : "outbound-rtp";
  const rtp = all.filter((e) => e.type === type);
  const kind = rtp.some((e) => e.kind === "video") ? "video" : "audio";
  const mine = rtp.filter((e) => e.kind === kind);
  const max = (k: string) => mine.reduce<number | undefined>((m, e) => typeof e[k] === "number" && e[k] > (m ?? -1) ? e[k] : m, undefined);
  const sum = (k: string) => mine.reduce((n, e) => n + (e[k] ?? 0), 0);
  const ts = mine[0]?.timestamp ?? Date.now(), bytes = sum(dir === "in" ? "bytesReceived" : "bytesSent");
  const s: Stats = { bytes, ts, w: max("frameWidth"), h: max("frameHeight"), fps: max("framesPerSecond") };
  if (prev && ts > prev.ts && bytes >= prev.bytes) s.kbps = Math.round((bytes - prev.bytes) * 8 / (ts - prev.ts));
  if (dir === "in") {
    const lost = sum("packetsLost"), got = sum("packetsReceived");
    if (lost + got > 0) s.loss = Math.round(1000 * lost / (lost + got)) / 10;
  } else {
    const remote = all.filter((e) => e.type === "remote-inbound-rtp" && e.kind === kind && typeof e.fractionLost === "number");
    if (remote.length) s.loss = Math.round(1000 * Math.max(...remote.map((e) => e.fractionLost))) / 10;
  }
  const pair = all.find((e) => e.type === "candidate-pair" && e.nominated && e.state === "succeeded" && typeof e.currentRoundTripTime === "number");
  if (pair) s.rtt = Math.round(pair.currentRoundTripTime * 1000);
  const codec = all.find((e) => e.type === "codec" && e.id === mine[0]?.codecId);
  if (codec?.mimeType) s.codec = String(codec.mimeType).split("/")[1];
  return s;
}

/** "1280×720 · 30fps · 1200kbps · 0.5% · 40ms · VP8" */
export const fmtStats = (s: Stats) => [s.w && s.h ? `${s.w}×${s.h}` : "", s.fps ? `${Math.round(s.fps)}fps` : "", s.kbps !== undefined ? `${s.kbps}kbps` : "",
  s.loss !== undefined ? `${s.loss}%` : "", s.rtt !== undefined ? `${s.rtt}ms` : "", s.codec ?? ""].filter(Boolean).join(" · ");

/** Endpoint name for the net log: /_matrix/client/v3/rooms/!x/send/… → rooms. */
export const endpointOf = (url: string) => new URL(url).pathname.split("/").slice(2).find((x) => !/^(client|media|v\d+|r0|unstable)$/.test(x)) ?? "?";

/** Oldest-first [key, size] entries: the keys to drop, oldest first, so the rest fit in `cap` bytes. */
export function toEvict(entries: [string, number][], cap: number): string[] {
  let total = entries.reduce((n, [, size]) => n + size, 0);
  const out: string[] = [];
  for (const [key, size] of entries) {
    if (total <= cap) break;
    out.push(key);
    total -= size;
  }
  return out;
}

/** The app lock's PIN check value: PBKDF2-SHA-256 over the PIN with a per-device salt, base64. Slow on purpose. */
export async function hashPin(pin: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

/** Wait before the next PIN try after `fails` wrong ones: none for the first 5, then 30s doubling, at most an hour. */
export const lockDelay = (fails: number) => (fails < 5 ? 0 : Math.min(3_600_000, 30_000 * 2 ** (fails - 5)));

/** One axis of a menu opened at `v`: after it, or before it when it would cross `max`; 8px from the edges. */
export const fitMenu = (v: number, size: number, max: number) => Math.max(8, Math.min(v + size > max - 8 ? v - size : v, max - size - 8));

// ---------- media auto-download ----------

export type DlKind = "photos" | "videos" | "files" | "gifs" | "voice";
export type DlWho = { dm: boolean; group: boolean };
/** maxMB: 0 = no limit. voice: voice messages and round videos. */
export type DlRules = { photos: DlWho; videos: DlWho & { maxMB: number }; files: DlWho & { maxMB: number }; gifs: DlWho; voice: DlWho };
export type AutoDl = { mobile: DlRules; wifi: DlRules };
const EVERYWHERE: DlWho = { dm: true, group: true };
export const AUTO_DL_DEFAULT: AutoDl = {
  wifi: { photos: EVERYWHERE, videos: { ...EVERYWHERE, maxMB: 50 }, files: { ...EVERYWHERE, maxMB: 50 }, gifs: EVERYWHERE, voice: EVERYWHERE },
  mobile: { photos: EVERYWHERE, videos: { ...EVERYWHERE, maxMB: 10 }, files: { ...EVERYWHERE, maxMB: 1 }, gifs: EVERYWHERE, voice: EVERYWHERE },
};

/** Stored rules over the defaults, per network and kind, so kinds added later get their defaults. */
export function mergeAutoDl(stored: unknown): AutoDl {
  const s = (stored ?? {}) as Partial<Record<keyof AutoDl, Partial<Record<DlKind, object>>>>;
  const net = (n: keyof AutoDl) => Object.fromEntries((Object.keys(AUTO_DL_DEFAULT[n]) as DlKind[])
    .map((k) => [k, { ...AUTO_DL_DEFAULT[n][k], ...s[n]?.[k] }])) as DlRules;
  return { mobile: net("mobile"), wifi: net("wifi") };
}

/** Whether media of `kind` (and `size` bytes, if known) downloads by itself in this kind of chat. */
export function shouldAutoDl(rules: DlRules, kind: DlKind, isDM: boolean, size?: number) {
  const r = rules[kind];
  if (!(isDM ? r.dm : r.group)) return false;
  return !("maxMB" in r) || !r.maxMB || !size || size <= r.maxMB * 1024 * 1024;
}

// ---------- blurhash (MSC2448: info["xyz.amorgan.blurhash"]) ----------

const B83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
const enc83 = (n: number, len: number) => { let s = ""; for (let i = len - 1; i >= 0; i--) s += B83[Math.floor(n / 83 ** i) % 83]; return s; };
const dec83 = (s: string) => [...s].reduce((n, c) => n * 83 + B83.indexOf(c), 0);
const toLinear = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v: number) => { const x = Math.max(0, Math.min(1, v)); return Math.trunc((x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055) * 255 + 0.5); };
const signPow = (v: number, e: number) => Math.sign(v) * Math.abs(v) ** e;

/** RGBA pixels (keep them small, ~32px: the cost is pixels × components) → blurhash. */
export function blurhashEncode(px: Uint8ClampedArray, w: number, h: number, cx = 4, cy = 3) {
  const f: number[][] = [];
  for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    const norm = i || j ? 2 : 1, rgb = [0, 0, 0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const basis = norm * Math.cos((Math.PI * i * x) / w) * Math.cos((Math.PI * j * y) / h), o = 4 * (x + y * w);
      for (let k = 0; k < 3; k++) rgb[k] += basis * toLinear(px[o + k]);
    }
    f.push(rgb.map((v) => v / (w * h)));
  }
  const [dc, ...ac] = f;
  const q = ac.length ? Math.max(0, Math.min(82, Math.floor(Math.max(...ac.flat().map(Math.abs)) * 166 - 0.5))) : 0;
  const maxV = (q + 1) / 166;
  const quant = (v: number) => Math.max(0, Math.min(18, Math.floor(signPow(v / maxV, 0.5) * 9 + 9.5)));
  return enc83(cx - 1 + (cy - 1) * 9, 1) + enc83(q, 1) + enc83((toSrgb(dc[0]) << 16) + (toSrgb(dc[1]) << 8) + toSrgb(dc[2]), 4)
    + ac.map((c) => enc83(quant(c[0]) * 361 + quant(c[1]) * 19 + quant(c[2]), 2)).join("");
}

/** blurhash → w×h RGBA pixels; null if it isn't a valid hash (it comes from other people's events). */
export function blurhashDecode(hash: string, w: number, h: number): Uint8ClampedArray | null {
  if (typeof hash !== "string" || hash.length < 6 || [...hash].some((c) => !B83.includes(c))) return null;
  const n = dec83(hash[0]), cy = Math.floor(n / 9) + 1, cx = (n % 9) + 1;
  if (hash.length !== 4 + 2 * cx * cy) return null;
  const maxV = (dec83(hash[1]) + 1) / 166, dc = dec83(hash.slice(2, 6));
  const colors = [[dc >> 16, (dc >> 8) & 255, dc & 255].map(toLinear)];
  for (let i = 1; i < cx * cy; i++) {
    const v = dec83(hash.slice(4 + 2 * i, 6 + 2 * i));
    colors.push([Math.floor(v / 361), Math.floor(v / 19) % 19, v % 19].map((d) => signPow((d - 9) / 9, 2) * maxV));
  }
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const rgb = [0, 0, 0];
    for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      const basis = Math.cos((Math.PI * x * i) / w) * Math.cos((Math.PI * y * j) / h), c = colors[i + j * cx];
      for (let k = 0; k < 3; k++) rgb[k] += c[k] * basis;
    }
    const o = 4 * (x + y * w);
    px.set([...rgb.map(toSrgb), 255], o);
  }
  return px;
}
