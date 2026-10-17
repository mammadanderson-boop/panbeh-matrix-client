// Messages that couldn't go out (offline, connection dropped) go out by themselves once the connection is back.
// Kept in localStorage too, per account, so a reload or Android killing the app doesn't lose them: on the next start
// they're sent again with the same transaction id, which the server dedupes if the first try did arrive after all.
// Plain text at rest, like drafts. Uploads that failed before their event existed are retried, but not kept.
import { ClientEvent, EventStatus, RoomEvent, SyncState, type EventTimelineSet, type MatrixEvent, type Room } from "matrix-js-sdk";
import { client, getUploads, pastFirstSync } from "./matrix.ts";

type Item = { roomId: string; threadId: string | null; type: string; content: Record<string, unknown> };

const storeKey = () => `panbeh.outbox:${client.getUserId()}`;
const load = (): Record<string, Item> => { try { return JSON.parse(localStorage.getItem(storeKey()) ?? "{}"); } catch { return {}; } };
const save = (o: Record<string, Item>) => {
  try { if (Object.keys(o).length) localStorage.setItem(storeKey(), JSON.stringify(o)); else localStorage.removeItem(storeKey()); } catch { /* full or blocked: memory only */ }
};

const failed = new Map<string, MatrixEvent>(); // txnId → the local echo, in the order they failed
const unsent = new Set<MatrixEvent>(); // local echoes the server hasn't sent back yet

/** A server refusal won't change on a retry (rate limits aside); only connection failures are worth resending. */
const refused = (ev: MatrixEvent) => { const s = ev.error?.httpStatus; return !!s && s >= 400 && s < 500 && s !== 429; };

let resending = false;
async function resendAll() {
  if (resending) return;
  resending = true;
  try {
    for (const [txn, ev] of [...failed]) {
      const room = client.getRoom(ev.getRoomId());
      if (!room || ev.status !== EventStatus.NOT_SENT || refused(ev)) continue;
      failed.delete(txn); // NOT_SENT again puts it back
      await client.resendEvent(ev, room).catch(() => {});
    }
  } finally { resending = false; }
  for (const u of getUploads()) if (u.error) u.retry();
}

function onEcho(ev: MatrixEvent) {
  const txn = ev.getTxnId();
  if (!txn) return;
  if (ev.status === null || ev.status === EventStatus.CANCELLED) unsent.delete(ev); else unsent.add(ev);
  const out = load();
  if (ev.status === EventStatus.NOT_SENT) {
    failed.set(txn, ev);
    // a redaction's target is outside its content in older rooms: those stay in memory only
    if (ev.getType() !== "m.room.redaction") out[txn] = { roomId: ev.getRoomId()!, threadId: ev.threadRootId ?? null, type: ev.getType(), content: ev.getContent() };
  } else if (ev.status === EventStatus.SENT || ev.status === EventStatus.CANCELLED || ev.status === null) {
    failed.delete(txn);
    delete out[txn];
  } else return;
  save(out);
}

/** A gappy sync (back on a slow or dropped connection) starts a new live timeline, and the SDK leaves local echoes
 *  in the old one, out of sight, even after they're sent. Once that sync's events are in, they move to its end.
 *  ponytail: one that the gappy sync itself brought back lands at the end, not at its place among those events */
function onReset(room: Room | undefined, set: EventTimelineSet) {
  if (!room || set !== room.getUnfilteredTimelineSet()) return;
  const mine = [...unsent].filter((e) => e.getRoomId() === room.roomId && !e.threadRootId);
  if (mine.length) client.once(ClientEvent.Sync, () => {
    const live = set.getLiveTimeline();
    for (const ev of mine) {
      if (ev.status === EventStatus.CANCELLED || set.getTimelineForEvent(ev.getId()!) === live) continue;
      set.removeEvent(ev.getId()!);
      set.addEventToTimeline(ev, live, { toStartOfTimeline: false, addToState: false });
    }
  });
}

/** Last time's unsent messages come back as local echoes (failing again at once if still offline). */
function replay() {
  for (const [txn, it] of Object.entries(load())) {
    if (!client.getRoom(it.roomId)) { const o = load(); delete o[txn]; save(o); continue; } // left the chat since
    client.sendEvent(it.roomId, it.threadId, it.type as never, it.content as never, txn).catch(() => {});
  }
}

/** Not in the headless page: one sender per device. Returns an unsubscribe. */
export function startSendQueue() {
  let last = client.getSyncState();
  let replayed = false;
  const onSync = (state: SyncState) => {
    if (!replayed && pastFirstSync()) { replayed = true; replay(); }
    if (state === SyncState.Syncing && last !== SyncState.Syncing) void resendAll();
    last = state;
  };
  client.on(RoomEvent.LocalEchoUpdated, onEcho);
  client.on(RoomEvent.TimelineReset, onReset);
  client.on(ClientEvent.Sync, onSync);
  onSync(last ?? SyncState.Stopped);
  return () => { client.off(RoomEvent.LocalEchoUpdated, onEcho); client.off(RoomEvent.TimelineReset, onReset); client.off(ClientEvent.Sync, onSync); };
}
