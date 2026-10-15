import { LOCALE, t } from "./i18n.ts";
import { EventType, MatrixEventEvent, MsgType, PushRuleActionName, PushRuleKind, ReceiptType, RoomEvent, type IRoomTimelineData, type MatrixEvent, type Room } from "matrix-js-sdk";
import { avatarUrl, client, pastFirstSync } from "./matrix.ts";
import { isGroupChat, previewText, senderMember, senderName, roomAvatarMxc } from "./ui/common.tsx";
import { loadPrefs } from "./ui/Settings.tsx";
import { isHeadless, isNative, nativeCancel, nativeNotify, nativeUnnotify, toDataUrl, type NotifyAction } from "./native.ts";
import { markRead } from "./chats.ts";
import { isAttentive, showWindow } from "./desktop.ts";

/** Muted = a room or override rule for this room that doesn't notify (ours, or Element's). */
export function isMuted(room: Room) {
  const g = client.pushRules?.global;
  const mutes = (r?: { rule_id: string; enabled: boolean; actions: unknown[] }) => !!r?.enabled && !r.actions.includes(PushRuleActionName.Notify);
  return mutes(g?.[PushRuleKind.RoomSpecific]?.find((r) => r.rule_id === room.roomId))
    || mutes(g?.[PushRuleKind.Override]?.find((r) => r.rule_id === room.roomId));
}

// a timed mute's end, as room account data ({ until: ms }): whichever of our clients is running then unmutes
// ponytail: a later mute from another app (Element) is still undone when our time runs out
const MUTE_UNTIL = "ir.panbeh.mute_until";
export const muteEnds = (room: Room): number | undefined => room.getAccountData(MUTE_UNTIL)?.getContent().until;

/** until: unmute then (ms); none = until turned back on. */
export async function setMuted(room: Room, mute: boolean, until?: number) {
  await client.setRoomMutePushRule("global", room.roomId, mute);
  // the SDK's typed account-data map doesn't list ours
  if (until || muteEnds(room)) await client.setRoomAccountData(room.roomId, MUTE_UNTIL as never, (mute && until ? { until } : {}) as never);
}

const unmuteExpired = () => {
  if (!pastFirstSync()) return;
  for (const room of client.getRooms()) {
    const t = muteEnds(room);
    if (t && t <= Date.now()) void setMuted(room, false).catch(() => {});
  }
};

/** The notification button's mute. */
const MUTE_BUTTON_MS = 8 * 3600_000;

const shown = new Set<string>();
/** Browser/desktop notifications on screen, per chat, so reading or deleting can close them. */
const open = new Map<string, { n: Notification; eventId?: string }>();
const clear = (roomId: string) => { if (isNative) nativeCancel(roomId); else open.get(roomId)?.n.close(); };

/** Notifications for new messages: desktop ones while the tab is open, Android ones in the app. Returns an unsubscribe. */
export function startNotifications() {
  const onTimeline = (ev: MatrixEvent, room: Room | undefined, toStart: boolean | undefined, _removed: boolean, data: IRoomTimelineData) => {
    if (toStart || !data?.liveEvent || !room || !pastFirstSync() || ev.getSender() === client.getUserId() || client.isUserIgnored(ev.getSender()!)) return;
    // push rules need the decrypted type and body
    if (ev.getType() === EventType.RoomMessageEncrypted && !ev.isDecryptionFailure()) ev.once(MatrixEventEvent.Decrypted, () => notify(ev, room));
    else notify(ev, room);
  };
  // notifications stay until dealt with: clear a chat's once it's read, here or on another device. Its unread count can lag
  // (encrypted chats count on the client, which keeps a stale count), so a receipt on the newest event is enough.
  const onReceipt = (ev: MatrixEvent, room: Room) => {
    const me = client.getUserId()!;
    const mine = Object.values(ev.getContent()).some((r) => [ReceiptType.Read, ReceiptType.ReadPrivate].some((t) => r?.[t]?.[me]));
    const last = room.getLiveTimeline().getEvents().filter((e) => !e.status).at(-1);
    if (mine && (room.getUnreadNotificationCount() === 0 || (last && room.hasUserReadEvent(me, last.getId()!)))) clear(room.roomId);
  };
  // a deleted message comes out of the notification (Android keeps several per chat; a browser one shows only the newest)
  const onRedaction = (ev: MatrixEvent, room: Room) => {
    const id = ev.getAssociatedId();
    if (!id) return;
    if (isNative) nativeUnnotify(room.roomId, id);
    else if (open.get(room.roomId)?.eventId === id) clear(room.roomId);
  };
  const onHash = () => { if (location.hash.length > 1) clear(location.hash.slice(1)); };
  const mutes = setInterval(unmuteExpired, 60_000);
  client.on(RoomEvent.Timeline, onTimeline);
  client.on(RoomEvent.Receipt, onReceipt);
  client.on(RoomEvent.Redaction, onRedaction);
  addEventListener("hashchange", onHash);
  return () => {
    client.off(RoomEvent.Timeline, onTimeline); client.off(RoomEvent.Receipt, onReceipt); client.off(RoomEvent.Redaction, onRedaction);
    removeEventListener("hashchange", onHash); clearInterval(mutes);
  };
}

async function notify(ev: MatrixEvent, room: Room) {
  if (/^m\.call\.|\.rtc\./.test(ev.getType())) return; // call.ts rings for calls (and .m.rule.call would turn every invite into a message)
  const id = ev.getId()!;
  const prefs = loadPrefs();
  if (!prefs.notify || shown.has(id)) return;
  if (!isNative && (!("Notification" in window) || Notification.permission !== "granted")) return;
  const actions = client.getPushActionsForEvent(ev, true); // server push rules: mute, mentions, keywords, edits…
  if (!actions?.notify) return;
  // the DM/group switches silence ordinary messages only; mentions and keywords still come through
  if (!actions.tweaks?.highlight && !(isGroupChat(room) ? prefs.notifyGroups : prefs.notifyDMs)) return;
  shown.add(id);
  const group = isGroupChat(room);
  await show(room, group ? senderName(ev) : "", previewText(ev), !!actions.tweaks?.sound, ev.getTs(),
    { eventId: id, mention: !!actions.tweaks?.highlight, senderMxc: group ? senderMember(ev)?.getMxcAvatarUrl() : undefined });
}

/** A notification about a call that didn't ring (missed, or a group call starting). group: obeys the group switch. */
export async function callNotice(room: Room, body: string, group = false) {
  const prefs = loadPrefs();
  if (!prefs.notify || (group && !prefs.notifyGroups)) return;
  if (!isNative && (!("Notification" in window) || Notification.permission !== "granted")) return;
  await show(room, "", body, true, Date.now(), { notice: true });
}

/** An avatar for a notification, or undefined if it isn't there in time. */
const notifyIcon = (mxc: string | null | undefined) => Promise.race([avatarUrl(mxc, 96)?.catch(() => undefined),
  new Promise<undefined>((r) => setTimeout(r, 1500))]);

/** sender: who wrote it, in a group ("" for a DM or a notice about the chat). The "content" setting can hide the text, or the chat too. */
async function show(room: Room, sender: string, text: string, sound: boolean, ts = Date.now(),
  more: { eventId?: string; mention?: boolean; senderMxc?: string | null; notice?: boolean } = {}) {
  // already looking at it (in the app, native checks the activity is on screen)
  if (!isNative && isAttentive() && location.hash.slice(1) === room.roomId) return;
  const preview = loadPrefs().notifyPreview;
  const hidden = preview === "none";
  if (preview !== "all" && !more.notice) text = t("notify.newMessage"); // a notice (missed call, failed reply) isn't someone's message
  if (hidden) sender = "";
  // the sync recalculates names only after emitting the batch's events: a member that names this room may have just arrived
  room.recalculate();
  const title = hidden ? t("app.name") : room.name, group = isGroupChat(room); // still a group when hidden: it picks the channel
  const body = (sender ? sender + ": " : "") + text;
  const [icon, senderIcon] = hidden ? [] : await Promise.all([notifyIcon(roomAvatarMxc(room)), group && more.senderMxc ? notifyIcon(more.senderMxc) : undefined]);
  if (isNative) {
    const data = (u?: string) => u && toDataUrl(u).catch(() => undefined);
    nativeNotify({
      roomId: room.roomId, eventId: more.eventId, title, body, sender, text, ts, group, sound, mention: more.mention, hidden,
      icon: await data(icon), senderIcon: await data(senderIcon),
      openRoom: isHeadless ? undefined : location.hash.slice(1),
    });
    return;
  }
  const n = new Notification(title, {
    body,
    tag: room.roomId, // newest message per chat replaces the previous one
    icon, lang: LOCALE, dir: "auto",
  });
  open.set(room.roomId, { n, eventId: more.eventId });
  n.onclose = () => { if (open.get(room.roomId)?.n === n) open.delete(room.roomId); };
  n.onclick = () => { showWindow(); location.hash = room.roomId; n.close(); };
  if (sound) ding();
}

/** The room once the client has it: a notification button may have woken a page that's still starting. */
async function roomWhenReady(roomId: string) {
  // ponytail: polls; a minute at most, then the press is dropped
  for (const end = Date.now() + 60_000; Date.now() < end && !(client && pastFirstSync() && client.getRoom(roomId));) await new Promise((r) => setTimeout(r, 500));
  return client?.getRoom(roomId) ?? null;
}

/** Reply, mark-as-read or mute from an Android message notification. Replying also marks the chat read, as in the app. */
export async function onNotifyButton(a: NotifyAction) {
  const room = await roomWhenReady(a.roomId);
  if (!room) return;
  if (a.action === "mute") return void setMuted(room, true, Date.now() + MUTE_BUTTON_MS).catch(() => {});
  if (a.action === "reply" && a.text) {
    try {
      await client.sendMessage(room.roomId, { msgtype: MsgType.Text, body: a.text });
    } catch {
      return void show(room, "", t("notify.replyFailed", { text: a.text }), false, Date.now(), { notice: true });
    }
  }
  await markRead(room).catch(() => {});
  nativeCancel(room.roomId);
}

let ctx: AudioContext | undefined;
/** Short beep; no sound file to ship. */
const ding = () => beep(880, 0.35);

function beep(freq: number, len: number, after = 0) {
  try {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + after;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + len);
  } catch { /* no audio: the notification is enough */ }
}

/** Call waiting: a soft double beep every 3s, over the call we're in. */
export function waitingTone() {
  const ring = () => { beep(440, 0.15); beep(440, 0.15, 0.3); };
  ring();
  const t = setInterval(ring, 3000);
  return () => clearInterval(t);
}

/** Incoming-call ring (two tones every 2s) until the returned stop is called. */
export function ringtone() {
  const ring = () => { beep(440, 0.4); beep(480, 0.4, 0.5); };
  ring();
  const t = setInterval(ring, 2000);
  return () => clearInterval(t);
}
