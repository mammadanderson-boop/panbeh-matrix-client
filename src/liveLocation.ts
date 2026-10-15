// Live location sharing (MSC3489 beacons): a per-room GPS watch (throttled to one beat per
// BEAT_MS) sends `m.beacon` events referencing an `m.beacon_info` state event — the SDK only
// reads positions from `m.beacon`, so `m.room.message` wouldn't do. Expiry is self-enforcing
// (the beacon goes stale server-side), and "stop" just turns it non-live. Other Panbeh (and
// Element) clients read the beacon from room state; this file only *sends* and exposes the
// local state.
import { t } from "./i18n.ts";
import { useSyncExternalStore } from "react";
import { M_BEACON, BeaconEvent, ClientEvent, ContentHelpers, LocationAssetType, RoomStateEvent, SyncState,
  type MatrixClient, type Room } from "matrix-js-sdk";
import { alertDialog } from "./ui/dialog.tsx";

/** One active sharing of ours; `ids` is every beacon_info event id it has sent (an extension sends a new one). */
type Sharing = { roomId: string; beaconId: string; ids: string[]; until: number; watchId: number; timer: number; lastBeat: number; lastError?: string };
const BEAT_MS = 30_000;
export const DURATIONS: [number, string][] = [
  [15 * 60_000, t("span.minutes", { count: 15 })],
  [60 * 60_000, t("span.hours", { count: 1 })],
  [8 * 3600_000, t("span.hours", { count: 8 })],
];

let sharings: Sharing[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

// beacon_info is keyed by user, not device: remember which beacons this device started (roomId → event id),
// so a reload turns off only those and not a share running on the user's phone
const mineKey = (c: MatrixClient) => `panbeh.liveBeacons.${c.getSafeUserId()}`;
const mine = (c: MatrixClient): Record<string, string> => { try { return JSON.parse(localStorage.getItem(mineKey(c)) ?? "{}"); } catch { return {}; } };
function remember(c: MatrixClient, roomId: string, beaconId?: string) {
  const m = mine(c);
  if (beaconId) m[roomId] = beaconId; else delete m[roomId];
  localStorage.setItem(mineKey(c), JSON.stringify(m));
}

export const useLiveLocation = () => useSyncExternalStore(subscribe, () => sharings);
export const sharingIn = (roomId: string) => sharings.find((s) => s.roomId === roomId) ?? null;

/** A geo URI's parts; null if malformed. */
const geoParts = (uri: string) => {
  const m = /^geo:(-?[\d.]+),(-?[\d.]+)/.exec(uri);
  return m ? { lat: +m[1], lon: +m[2] } : null;
};

/** Send one position as an m.beacon beat. */
async function sendBeat(c: MatrixClient, roomId: string, beaconId: string, p: GeolocationPosition) {
  const la = +p.coords.latitude.toFixed(6), lo = +p.coords.longitude.toFixed(6);
  const acc = Math.round(p.coords.accuracy);
  await c.sendEvent(roomId, M_BEACON.name, ContentHelpers.makeBeaconContent(`geo:${la},${lo};u=${acc}`, Date.now(), beaconId));
}

/** A denied permission must not leave a beacon live with no position: alert and stop, like shareLocation does. Other errors (a bad fix, a timeout) are transient: the next watch tick retries. */
function geoError(c: MatrixClient, roomId: string) {
  return (e: GeolocationPositionError) => {
    if (e.code !== e.PERMISSION_DENIED) return;
    void stopSharing(c, roomId);
    alertDialog(t("loc.denied"));
  };
}

/** Start sharing this device's location into `room` for `duration` ms; an already-running share gets the new duration instead. */
export async function startSharing(c: MatrixClient, room: Room, duration: number) {
  const existing = sharingIn(room.roomId);
  if (existing) return extendSharing(c, existing, duration);
  const roomId = room.roomId;
  // a position first: a denied permission or no fix must fail here, not after the room was told we're sharing
  if (!navigator.geolocation) throw new Error(t("loc.unsupported"));
  const first = await new Promise<GeolocationPosition>((ok, fail) => navigator.geolocation.getCurrentPosition(ok,
    (e) => fail(new Error(e.code === e.PERMISSION_DENIED ? t("loc.denied") : t("loc.notFound"))),
    { enableHighAccuracy: true, timeout: 20_000 }));
  const until = Date.now() + duration;

  // the state event must exist before the first beat references it
  const info = ContentHelpers.makeBeaconInfoContent(duration, true, t("loc.live"), LocationAssetType.Self, Date.now());
  const { event_id: beaconId } = await c.unstable_setLiveBeacon(roomId, info as never);

  remember(c, roomId, beaconId);
  const s: Sharing = { roomId, beaconId, ids: [beaconId], until, watchId: 0, timer: 0, lastBeat: 0 };
  const beat = (pos: GeolocationPosition | null) => {
    // watchPosition fires on every move, sometimes every second: at most one beat per BEAT_MS
    if (!pos || Date.now() - s.lastBeat < BEAT_MS) return;
    s.lastBeat = Date.now();
    sendBeat(c, roomId, s.beaconId, pos)
      .catch((e) => { s.lastError = (e as Error).message; emit(); });
  };
  const onError = geoError(c, roomId);
  s.watchId = navigator.geolocation.watchPosition(beat, onError,
    { enableHighAccuracy: true, maximumAge: BEAT_MS, timeout: 20_000 });
  s.timer = window.setTimeout(() => stopSharing(c, roomId), duration);
  sharings = [...sharings, s];
  emit();
  beat(first); // right away, so the map isn't empty for 30s
}

/** An active share picks a new duration: the beacon_info is re-sent (the SDK swaps the beacon to the new event id) and the local timer resets; the GPS watch keeps going. */
async function extendSharing(c: MatrixClient, s: Sharing, duration: number) {
  const info = ContentHelpers.makeBeaconInfoContent(duration, true, t("loc.live"), LocationAssetType.Self, Date.now());
  const { event_id: beaconId } = await c.unstable_setLiveBeacon(s.roomId, info as never);
  s.beaconId = beaconId; // beats from now on reference the new state event
  s.ids.push(beaconId);
  remember(c, s.roomId, beaconId);
  s.until = Date.now() + duration;
  clearTimeout(s.timer);
  s.timer = window.setTimeout(() => stopSharing(c, s.roomId), duration);
  s.lastBeat = 0; // the update clears others' cached position: beat right away
  emit();
}

/** Stop sharing in a room: the GPS watch and timer go, the beacon is set live:false so others' maps stop too. */
export async function stopSharing(c: MatrixClient, roomId: string) {
  const s = sharingIn(roomId);
  if (!s) return;
  sharings = sharings.filter((x) => x.roomId !== roomId);
  emit();
  remember(c, roomId);
  navigator.geolocation.clearWatch(s.watchId);
  clearTimeout(s.timer);
  const room = c.getRoom(roomId);
  const prev = room?.currentState.getStateEvents("m.beacon_info" as never, c.getSafeUserId());
  // beacon_info is per user: one we never sent means another device of ours started sharing here since, so leave it live.
  // No prev yet (stopped before sync echoed ours back) still turns ours off.
  if (prev && !s.ids.includes(prev.getId()!)) return;
  const timeout = (prev?.getContent() as { timeout?: number } | undefined)?.timeout ?? s.until - Date.now();
  await c.unstable_setLiveBeacon(roomId, ContentHelpers.makeBeaconInfoContent(Math.max(timeout, 0), false, t("loc.live"), LocationAssetType.Self, Date.now()) as never).catch(() => {});
}

/** Stops everything (logout, account switch). */
export async function stopAll(c: MatrixClient) {
  for (const s of [...sharings]) await stopSharing(c, s.roomId);
}

/** On boot: this device's beacons from a previous page load still look live but nothing is watching (or stopping)
 *  them, so turn them off. Rooms only arrive with the first sync, which startClient doesn't wait for. */
export function clearStaleBeacons(c: MatrixClient) {
  if (!Object.keys(mine(c)).length) return;
  const onSync = (state: SyncState) => {
    if (state !== SyncState.Prepared) return;
    c.off(ClientEvent.Sync, onSync);
    for (const [roomId, beaconId] of Object.entries(mine(c))) {
      if (sharingIn(roomId)) continue; // started again since boot
      remember(c, roomId);
      const prev = c.getRoom(roomId)?.currentState.getStateEvents("m.beacon_info" as never, c.getSafeUserId());
      if (prev?.getId() !== beaconId || !(prev.getContent() as { live?: boolean }).live) continue; // replaced or already off
      const timeout = (prev.getContent() as { timeout?: number }).timeout ?? 0;
      void c.unstable_setLiveBeacon(roomId, ContentHelpers.makeBeaconInfoContent(timeout, false, t("loc.live"), LocationAssetType.Self, Date.now()) as never).catch(() => {});
    }
  };
  c.on(ClientEvent.Sync, onSync);
}

/** Another device's or person's live share in `room`, as {name, lat, lon, ts} entries for the header line. */
export function liveBeacons(room: Room): { userId: string; name: string; lat: number; lon: number; ts: number }[] {
  const out: { userId: string; name: string; lat: number; lon: number; ts: number }[] = [];
  for (const beacon of room.currentState.beacons.values()) {
    if (!beacon.isLive || !beacon.latestLocationState) continue;
    const geo = geoParts(beacon.latestLocationState.uri ?? "");
    if (!geo) continue;
    const id = beacon.beaconInfoOwner!, member = room.getMember(id);
    out.push({ userId: id, name: member?.name ?? id, lat: geo.lat, lon: geo.lon, ts: beacon.latestLocationState.timestamp ?? 0 });
  }
  return out;
}

/** Re-render the header when liveness changes (a beacon expires, a new one arrives). */
const BEACON_EVENTS = [RoomStateEvent.BeaconLiveness, BeaconEvent.Update, BeaconEvent.LocationUpdate];
export function onBeaconChange(room: Room, f: () => void): () => void {
  const state = room.currentState as unknown as {
    on(e: string, h: () => void): void; off(e: string, h: () => void): void;
  };
  for (const e of BEACON_EVENTS) state.on(e, f);
  return () => {
    for (const e of BEACON_EVENTS) state.off(e, f);
  };
}