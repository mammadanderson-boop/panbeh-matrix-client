import { t } from "./i18n.ts";
import { client, openDM } from "./matrix.ts";
import { errText } from "./ui/common.tsx";
import { requestJump } from "./ui/Search.tsx";
import { parseMatrixHash, parseMatrixLink, type Target } from "./uri.ts";
import { alertDialog, confirmDialog } from "./ui/dialog.tsx";

/** Links that arrived before the first sync (cold start): the Shell drains them once it can navigate. */
const queue: string[] = [];
const EVENT = "panbeh-open-link";

/** Entry point for every platform: a matrix.to link or `matrix:` URI from outside or inside the app. */
export function handleIncomingLink(link: string) {
  queue.push(link);
  window.dispatchEvent(new Event(EVENT));
}

/** Calls `run` for queued and future links. Only call while synced. Returns an unsubscribe. */
export function drainLinks() {
  const flush = () => { for (const l of queue.splice(0)) openLink(l).catch((e) => alertDialog(errText(e))); };
  window.addEventListener(EVENT, flush);
  flush();
  return () => window.removeEventListener(EVENT, flush);
}

const findRoom = (id: string) =>
  id.startsWith("!") ? client.getRoom(id) : client.getRooms().find((r) => r.getCanonicalAlias() === id || r.getAltAliases().includes(id));
const joinedRoom = (id: string) => { const r = findRoom(id); return r?.getMyMembership() === "join" ? r : null; };

async function openLink(link: string) {
  const t = parseMatrixLink(link) ?? parseMatrixHash(link);
  if (t) await openTarget(t);
}

export async function openTarget(to: Target) {
  if (to.kind === "user") {
    if (to.id === client.getUserId()) return;
    if (!(await confirmDialog(t("open.dm", { id: to.id })))) return;
    location.hash = await openDM(to.id);
    return;
  }
  let roomId = joinedRoom(to.id)?.roomId;
  let via = to.via;
  if (!roomId) {
    if (!(await confirmDialog(t("open.join", { id: to.id })))) return;
    if (to.kind === "roomAlias") {
      const r = await client.getRoomIdForAlias(to.id);
      via = via.length ? via : r.servers;
    }
    roomId = (await client.joinRoom(to.id, via.length ? { viaServers: via } : undefined)).roomId;
  }
  location.hash = roomId;
  if (to.eventId) requestJump(roomId, to.eventId);
}
