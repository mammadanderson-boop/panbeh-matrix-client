import { rtl, t } from "../i18n.ts";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EventType, M_POLL_START, type MatrixEvent, type Room } from "matrix-js-sdk";
import { PollStartEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollStartEvent.js";
import { avatarUrl, client, isDirect } from "../matrix.ts";
import { usePromise } from "../hooks.ts";
import { getCallNotificationExpiry, type IRTCNotificationContent } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { errorText, fitMenu, fmtDuration, HISTORY, isGif, isVideoOffer, JOIN_RULES, legacyOutcome, levelChanges, num, roleLabel, rtcOutcome, type CallEv, type CallOutcome } from "../logic.ts";
import { Icon } from "../icons.tsx";
import { useDismiss } from "./useDismiss.ts";
import { useBackdropHold } from "./useBackdropHold.ts";

const COLORS = ["#e17076", "#faa774", "#a695e7", "#7bc862", "#6ec9cb", "#65aadd", "#ee7aae"];
export const colorFor = (id: string) => COLORS[([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0) >>> 0) % COLORS.length];

export function Avatar({ mxc, name, id, size = 42 }: { mxc?: string | null; name: string; id: string; size?: number }) {
  const url = usePromise(avatarUrl(mxc, size * 2));
  const letter = [...name.replace(/^[@#!]/, "")][0]?.toUpperCase() ?? "?";
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: url ? undefined : colorFor(id) }}>
      {url ? <img src={url} alt="" draggable={false} /> : letter}
    </div>
  );
}

/** The room's photo; a DM without one shows the other person's. Groups never borrow a member's photo:
 *  the SDK's fallback picks one for any room with ≤2 members, which then vanished when a third joined. */
export const roomAvatarMxc = (room: Room) =>
  room.getMxcAvatarUrl() ?? (isDirect(room) ? room.getAvatarFallbackMember()?.getMxcAvatarUrl() : undefined);

export const RoomAvatar = ({ room, size }: { room: Room; size?: number }) => (
  <Avatar mxc={roomAvatarMxc(room)} name={room.name} id={room.roomId} size={size} />
);

/** The sender's *current* profile; ev.sender is a snapshot from when it was sent. */
export const senderMember = (ev: MatrixEvent) => client.getRoom(ev.getRoomId())?.getMember(ev.getSender()!) ?? ev.sender;
export const senderName = (ev: MatrixEvent) => senderMember(ev)?.name ?? ev.getSender() ?? "";

/** Three bouncing dots after "typing" text. */
export const Dots = () => <span className="dots" aria-hidden><i /><i /><i /></span>;

/** True for a moment after `value` changes (not on mount): drives one-shot "bump" animations. */
export function useChange(value: unknown, ms = 450) {
  const prev = useRef(value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return on;
}

/** Small transient message at the bottom of the screen. */
export function toast(text: string) {
  const el = Object.assign(document.createElement("div"), { className: "toast", textContent: text });
  el.setAttribute("role", "status");
  document.body.append(el);
  setTimeout(() => el.classList.add("closing"), 1550);
  setTimeout(() => el.remove(), 1800);
}

/** Clipboard write; the textarea fallback covers insecure origins and WebViews without the async API. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = Object.assign(document.createElement("textarea"), { value: text });
    t.style.cssText = "position:fixed;opacity:0";
    document.body.append(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    if (!ok) throw new Error("copy failed");
  }
}

/** Bidi-isolate a name inside a Farsi sentence so Latin names/punctuation don't reorder it. */
export const bdi = (s: string) => "\u2068" + s + "\u2069";

/** Our message for an SDK/fetch error. */
export function errText(e: unknown): string {
  const err = e as { errcode?: string; message?: string; name?: string; data?: { retry_after_ms?: number } };
  const known = errorText(err?.errcode, err?.data);
  if (known) return known;
  // getUserMedia (calls, voice messages)
  if (err?.name === "NotAllowedError") return t("err.mediaDenied");
  if (err?.name === "NotFoundError") return t("err.mediaNotFound");
  const m = err?.message ?? String(e);
  return /fetch|network/i.test(m) ? t("err.network") : m;
}

const cap = (c: Record<string, any>): string | undefined => (c.filename && c.body !== c.filename ? formattedPlain(c)?.text ?? c.body : undefined);

const BLOCK = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE|UL|OL|TR)$/;
const plainCache = new WeakMap<object, { text: string; emotes: Map<string, string> } | null>();
/** A formatted message's text as it reads: no markup (so no markdown markers), spoilers hidden, custom emoji as
 *  ":code:" with their mxc in `emotes`. null when it has no formatted_body. */
export function formattedPlain(c: Record<string, any>) {
  if (plainCache.has(c)) return plainCache.get(c)!;
  let out = null;
  if (c.format === "org.matrix.custom.html" && typeof c.formatted_body === "string") {
    // inert: a parsed document loads nothing and runs nothing
    const doc = new DOMParser().parseFromString(c.formatted_body, "text/html");
    doc.querySelectorAll("mx-reply").forEach((n) => n.remove());
    const emotes = new Map<string, string>();
    let text = "";
    const walk = (n: Node) => {
      for (const k of n.childNodes) {
        if (k.nodeType === Node.TEXT_NODE) { text += k.textContent; continue; }
        if (!(k instanceof Element)) continue;
        if (k.tagName === "BR") text += "\n";
        else if (k.hasAttribute("data-mx-spoiler")) text += "▒▒▒";
        else if (k.tagName === "IMG") {
          const alt = k.getAttribute("alt") ?? "", m = /^:([^:\s]+):$/.exec(alt), src = k.getAttribute("src") ?? "";
          if (m && k.hasAttribute("data-mx-emoticon") && src.startsWith("mxc://")) emotes.set(m[1], src);
          text += alt;
        } else {
          if (BLOCK.test(k.tagName) && text && !text.endsWith("\n")) text += "\n";
          walk(k);
        }
      }
    };
    walk(doc.body);
    out = { text: text.trim(), emotes };
  }
  plainCache.set(c, out);
  return out;
}

/** One-line text for list previews and reply quotes. */
export function previewText(ev: MatrixEvent): string {
  if (ev.isDecryptionFailure()) return "🔒 " + t("preview.encrypted");
  if (ev.getType() === EventType.RoomMessageEncrypted) return "🔒 " + t("preview.decrypting");
  const c = ev.getContent();
  switch (c.msgtype) {
    case "m.image": return "🖼 " + (cap(c) ?? t("preview.photo"));
    case "m.video": return c["app.panbeh.video_note"] ? "📹 " + t("voice.videoMessage") + " " + fmtDuration(c.info?.duration ?? 0) : isGif(c) ? "🎞 " + (cap(c) ?? t("preview.gif")) : "🎬 " + (cap(c) ?? t("preview.video"));
    case "m.audio": return isVoice(c) ? "🎤 " + t("voice.message") + " " + fmtDuration(audioDuration(c)) : "🎵 " + t("preview.audio");
    case "m.location": return "📍 " + t("loc.title");
    case "m.file": return "📎 " + (cap(c) ?? c.filename ?? c.body ?? t("composer.file"));
    case "m.emote": return `* ${senderName(ev)} ${formattedPlain(c)?.text ?? c.body}`;
    case VERIFY_REQUEST: return "🔐 " + t("preview.verify");
  }
  if (ev.getType() === EventType.Sticker) return t("preview.sticker");
  if (M_POLL_START.matches(ev.getType())) return "📊 " + (parsePoll(ev)?.question.text ?? t("poll.poll"));
  return formattedPlain(c)?.text ?? stripReplyFallback(String(c.body ?? ""));
}

type Content = Record<string, any>;
export const isVoice = (c: Content) => !!(c["org.matrix.msc3245.voice"] ?? c["m.voice"]);
/** ms; 0 if unknown */
export const audioDuration = (c: Content): number => c.info?.duration ?? c["org.matrix.msc1767.audio"]?.duration ?? 0;

/** Poll start content (edit-aware, stable or unstable names); null if malformed. */
export function parsePoll(ev: MatrixEvent) {
  try { return new PollStartEvent({ type: ev.getType(), content: ev.getContent() as never }); } catch { return null; }
}

export const stripReplyFallback = (body: string) => body.replace(/^(> .*\n)+\n?/, "");

/** In-chat verification starts with an m.room.message whose body is an English "your client doesn't support" fallback. */
export const VERIFY_REQUEST = "m.key.verification.request";

/** Text for state events worth showing as a centered pill; null = hide. */
export function noticeText(ev: MatrixEvent): string | null {
  const who = bdi(senderName(ev));
  const c = ev.getContent(), prev = ev.getPrevContent();
  switch (ev.getType()) {
    case EventType.RoomMessage: return c.msgtype === VERIFY_REQUEST ? t("notice.verify", { who }) : null;
    case EventType.RoomCreate:
      return c.predecessor?.room_id ? t("notice.continued") : t(c.type === "m.space" ? "notice.createdSpace" : "notice.createdChat", { who });
    case EventType.RoomName: return c.name ? t("notice.name", { who, name: bdi(c.name) }) : t("notice.nameRemoved", { who });
    case EventType.RoomTopic: {
      const topic: string = c.topic ?? "";
      return topic ? t("notice.topic", { who, topic: bdi(topic.length > 80 ? topic.slice(0, 80) + "…" : topic) }) : t("notice.topicRemoved", { who });
    }
    case EventType.RoomAvatar: return c.url ? t("notice.avatar", { who }) : t("notice.avatarRemoved", { who });
    case EventType.RoomCanonicalAlias:
      if (c.alias === prev.alias) return null; // alt_aliases only
      return c.alias ? t("notice.alias", { who, alias: bdi(c.alias) }) : t("notice.aliasRemoved", { who, alias: bdi(prev.alias) });
    case EventType.RoomServerAcl: return t("notice.acl", { who });
    case EventType.RoomGuestAccess:
      return prev.guest_access && c.guest_access !== prev.guest_access ? (c.guest_access === "can_join" ? t("notice.guestsOn", { who }) : t("notice.guestsOff", { who })) : null;
    case EventType.RoomEncryption: return t("notice.encrypted");
    case EventType.RoomPinnedEvents: {
      const n = c.pinned?.length ?? 0, was = prev.pinned?.length ?? 0;
      return n > was ? t("notice.pinned", { who }) : n < was ? t("notice.unpinned", { who }) : null;
    }
    case EventType.RoomMember: {
      const target = bdi(c.displayname ?? ev.getStateKey() ?? "");
      const prevName = bdi(prev.displayname ?? c.displayname ?? ev.getStateKey() ?? "");
      if (c.membership === prev.membership) return null; // profile changes are noise
      const reason = c.reason ? t("notice.reason", { reason: bdi(c.reason) }) : "";
      switch (c.membership) {
        case "join": return t("notice.joined", { target });
        case "invite": return t("notice.invited", { who, target });
        case "knock": return t("notice.knocked", { target });
        case "leave":
          if (ev.getSender() === ev.getStateKey()) {
            return prev.membership === "knock" ? t("notice.knockWithdrawn", { name: prevName }) : prev.membership === "invite" ? t("notice.inviteRejected", { name: prevName }) : t("notice.left", { name: prevName });
          }
          return prev.membership === "ban" ? t("notice.unbanned", { who, name: prevName })
            : prev.membership === "knock" ? t("notice.knockDenied", { who, name: prevName })
            : prev.membership === "invite" ? t("notice.inviteRevoked", { who, name: prevName })
            : t("notice.kicked", { who, name: prevName }) + reason;
        case "ban": return t("notice.banned", { who, name: prevName }) + reason;
      }
      return null;
    }
    // room creation sets these too; only later changes are news
    case EventType.RoomPowerLevels: {
      if (!Object.keys(prev).length) return null; // room creation; v12 rooms start without `users` (creators are implicit)
      const [c1, ...more] = levelChanges(prev as never, c as never);
      // servers send canonical (sorted-key) JSON, so equal content stringifies equally
      if (!c1) return JSON.stringify(prev) === JSON.stringify(c) ? null : t("notice.permissions", { who });
      const name = bdi(client.getRoom(ev.getRoomId())?.getMember(c1.id)?.name ?? c1.id);
      return t("notice.role", { who, name, role: roleLabel(c1.to) ?? t("role.member") }) + (more.length ? t("notice.roleMore", { count: more.length }) : "");
    }
    case EventType.RoomJoinRules:
      return prev.join_rule && c.join_rule !== prev.join_rule ? t("notice.joinRule", { who, rule: JOIN_RULES[c.join_rule] ?? c.join_rule }) : null;
    case EventType.RoomHistoryVisibility:
      return prev.history_visibility && c.history_visibility !== prev.history_visibility ? t("notice.history", { who, v: HISTORY[c.history_visibility] ?? c.history_visibility }) : null;
    case EventType.RoomTombstone: return t("notice.upgraded", { who });
    case EventType.RTCNotification:
    case EventType.CallInvite: {
      const i = callInfo(ev);
      if (!i) return t(c["m.call.intent"] === "video" ? "call.groupVideo" : "call.groupVoice", { name: who });
      return callLine(ev, who, i.video, i.outcome);
    }
  }
  return null;
}

const callEv = (e: MatrixEvent): CallEv => ({ id: e.getId(), type: e.getType(), sender: e.getSender()!, ts: e.getTs(), content: e.getContent() });
/** A 1:1 ring (MatrixRTC or legacy): video or not, and how it went. Null for a group call's "started" alert. */
export function callInfo(ev: MatrixEvent): { video: boolean; outcome: CallOutcome } | null {
  const c = ev.getContent();
  if (ev.getType() === EventType.CallInvite) return { video: isVideoOffer(c as { offer?: { sdp?: string } }), outcome: legacyOutcome(callEv(ev), eventsAfter(ev)) };
  if (c.notification_type !== "ring") return null;
  return { video: c["m.call.intent"] === "video", outcome: rtcOutcome(callEv(ev), getCallNotificationExpiry(c as IRTCNotificationContent, ev.getTs()), eventsAfter(ev)) };
}

/** The loaded events after `ev`, to see how its call went. */
function eventsAfter(ev: MatrixEvent) {
  const evs = client.getRoom(ev.getRoomId())?.getTimelineForEvent(ev.getId()!)?.getEvents() ?? [];
  return evs.slice(evs.indexOf(ev) + 1).map(callEv);
}

/** A 1:1 call's line in the timeline: who called, and how it went. */
function callLine(ev: MatrixEvent, who: string, video: boolean, o: CallOutcome) {
  const mine = ev.getSender() === me(), kind = video ? t("callKind.video") : t("callKind.voice");
  switch (o.state) {
    case "ended": return t("callLine.made", { who, kind }) + " · " + fmtDuration(o.duration!);
    case "missed": return mine ? t("callLine.unanswered", { kind }) : t("callLine.missedFrom", { kind, who });
    case "declined": return mine ? t("callLine.declinedMine", { kind }) : t("callLine.declinedTheirs", { kind, who });
    default: return t("callLine.made", { who, kind });
  }
}

export const isGroupChat = (room: Room) => room.getJoinedMemberCount() > 2;

export const me = () => client.getSafeUserId();

export function formatSize(n: number) {
  const u = [t("size.b"), t("size.kb"), t("size.mb"), t("size.gb")];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${num(+n.toFixed(i ? 1 : 0))} ${u[i]}`;
}

/** Side sheet: settings, chat info, new chat, seen-by. */
const InSheet = createContext(false);

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const nested = useContext(InSheet);
  const [closing, close] = useDismiss(onClose, 220);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { // Esc closes the topmost sheet only (sheets stack: a sub-page opens inside its parent), wherever focus is
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const open = [...document.querySelectorAll("[role=dialog], [role=menu], [role=listbox]")].filter((el) => !el.closest(".closing"));
      if (open[open.length - 1] !== ref.current) return; // a menu, dialog or sheet above this one handles it
      e.preventDefault();
      close();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [close]);
  const ui = (
    <div className={"sheet-backdrop" + (closing ? " closing" : "")} onClick={close}>
      <div className="sheet" ref={ref} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={close} aria-label={t("common.close")}><Icon name="close" /></button>
        </header>
        <InSheet.Provider value>{children}</InSheet.Provider>
      </div>
    </div>
  );
  // a top-level sheet goes to the body: opened from inside a stacking context (the composer's z-index), it would sit under the
  // sidebar's new-chat button. A page opened inside another stays in it: mounted together, it would land under its parent
  return nested ? ui : createPortal(ui, document.body);
}

/** Where a menu opened at (x, y) goes: right of and below it, flipped to the other side where it doesn't fit, kept on screen. */
export function menuPos(x: number, y: number, el: HTMLElement) {
  const { offsetWidth: w, offsetHeight: h } = el; // not the rect: the pop-in animation starts scaled down
  return { left: fitMenu(x, w, innerWidth), top: fitMenu(y, h, innerHeight) };
}

/** Right-click / long-press menu at (x, y), kept on screen. Holding another `target` underneath switches the menu to it. */
export function ContextMenu({ x, y, target, onClose, children }: { x: number; y: number; target: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [closing, close] = useDismiss(onClose, 160);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => { // keep it on screen
    setPos(menuPos(x, y, ref.current!));
    ref.current!.querySelector("button")?.focus();
  }, [x, y]);
  const backdrop = useBackdropHold(onClose, target, close);
  // portaled, and Esc stops here: a sheet underneath would otherwise close too
  return createPortal(
    <div className={"chat-menu-backdrop" + (closing ? " closing" : "")} {...backdrop}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}>
      <div className="chat-menu" role="menu" ref={ref} style={pos} onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>,
    document.body,
  );
}

/** Dropdown in the app's menu style (a bottom sheet on phones): Android WebView's native picker looks foreign. */
export function Select<T extends string | number>({ value, options, onChange, disabled }:
  { value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const [closing, close] = useDismiss(() => setAt(null), 150);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => { // under the button, kept on screen
    if (!at) return setPos(undefined);
    const { offsetWidth: w, offsetHeight: h } = menu.current!; // not the rect: the pop-in animation starts scaled down
    setPos({ left: Math.max(8, Math.min(rtl ? at.right - w : at.left, innerWidth - w - 8)), top: at.bottom + h + 8 > innerHeight ? Math.max(8, at.top - h - 4) : at.bottom + 4 });
    menu.current!.focus({ preventScroll: true });
  }, [at]);
  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [at, close]);
  const pick = (v: T) => { setAt(null); if (v !== value) onChange(v); };
  return (
    <>
      <button type="button" className="select" disabled={disabled} aria-haspopup="listbox" aria-expanded={!!at}
        onClick={(e) => { e.preventDefault(); setAt(e.currentTarget.getBoundingClientRect()); }}>
        <span>{options.find(([v]) => v === value)?.[1] ?? String(value)}</span><Icon name="down" size={18} />
      </button>
      {at && createPortal(
        <div className={"chat-menu-backdrop msg-menu-backdrop select-backdrop" + (closing ? " closing" : "")} onClick={close}>
          <div className="chat-menu msg-menu select-menu" role="listbox" tabIndex={-1} ref={menu} onClick={(e) => e.stopPropagation()}
            style={{ minWidth: at.width, ...(pos ?? { left: 0, top: 0, visibility: "hidden" }) }}>
            {options.map(([v, label]) => (
              <button key={v} type="button" role="option" aria-selected={v === value} className={v === value ? "on" : undefined} onClick={() => pick(v)}>
                <Icon name="check" /> {label}
              </button>
            ))}
          </div>
        </div>,
        document.body)}
    </>
  );
}
