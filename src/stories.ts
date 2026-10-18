// Stories: Telegram/WhatsApp-style 24h posts. Matrix has no stories, so this rides a dedicated encrypted room per
// person: every story is an m.image/m.video carrying `ir.panbeh.story.exp` (24h ahead). Other clients just see it as
// an odd little chat; Panbeh flags the room with an `ir.panbeh.story` state marker and separates it from the chat list.
// Viewing = reading the room: read receipts double as "seen" markers, so rings and ordering come for free.
// ponytail: story history beyond the live timeline window is not fetched; a low-traffic 24h room stays within it.
import { Preset, type MatrixEvent, type Room } from "matrix-js-sdk";
import { client, dmPeer, isDirect, sendFile, ENCRYPTION } from "./matrix.ts";
import { isStory, storySort, STORY_EXP } from "./logic.ts";

export const STORY = "ir.panbeh.story"; // room state marker: this room only shows stories
const MINE = "ir.panbeh.story.mine"; // my room-account flag: which story room is mine

export const isStoryRoom = (room: Room) => !!room.currentState.getStateEvents(STORY, "");

export const storyRooms = (): Room[] =>
  client.getRooms().filter((r) => r.getMyMembership() === "join" && isStoryRoom(r));

/** Everyone I have a DM with = my audience (WhatsApp's rule), best effort: invited once at post time. */
const peers = () => {
  const out = new Set<string>();
  for (const r of client.getRooms()) if (isDirect(r)) { const p = dmPeer(r); if (p) out.add(p); }
  return [...out];
};

export async function ensureStoryRoom(): Promise<Room> {
  const cur = storyRooms()?.find((r) => !!r.getAccountData(MINE as never));
  if (cur) return cur;
  const { room_id } = await client.createRoom({
    preset: Preset.PrivateChat,
    initial_state: [ENCRYPTION, { type: STORY, state_key: "", content: {} }],
    invite: peers(),
  });
  await client.setRoomAccountData(MINE as never, room_id, {});
  const room = client.getRoom(room_id);
  if (!room) throw new Error("story room vanished after create");
  return room;
}

export async function sendStory(file: File, caption = "") {
  const room = await ensureStoryRoom();
  // contacts met after the room was made get invited with the next story
  await Promise.all(peers().filter((u) => room.getMember(u)?.membership !== "join" && room.getMember(u)?.membership !== "invite")
    .map((u) => client.invite(room.roomId, u).catch(() => {})));
  await sendFile(room, file, null, undefined, { [STORY_EXP]: Date.now() + 86_400_000 }, { caption: caption || undefined });
}

/** This room's live stories, oldest first. */
export function storiesOf(room: Room): MatrixEvent[] {
  return room.getLiveTimeline().getEvents()
    .filter((e) => !e.status && !e.isRedacted() && isStory(e.getContent()) && (e.getContent()[STORY_EXP] as number) > Date.now())
    .sort((a, b) => a.getTs() - b.getTs());
}

/** Unseen = a live story newer than my read marker in the room. */
export function hasUnseen(room: Room) {
  const readTs = room.getEventReadUpTo(client.getSafeUserId()) || 0;
  return storiesOf(room).some((e) => e.getTs() > readTs);
}

/** The lane's rooms, ordered: my room first, then fresh stories first; rooms without live stories drop out. */
export function storyLanes(): Room[] {
  const rooms = storyRooms();
  const mine = rooms.find((r) => !!r.getAccountData(MINE as never));
  return storySort(rooms.map((r) => ({ mine: r === mine, ts: Math.max(0, ...storiesOf(r).map((e) => e.getTs())) })))
    .map((i) => rooms[i]).filter((r) => storiesOf(r).length);
}

export const markStorySeen = (ev: MatrixEvent) => client.sendReadReceipt(ev).catch(() => {});