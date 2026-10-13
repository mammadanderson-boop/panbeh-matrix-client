import { useCallback, useEffect, useMemo, useState } from "react";
import { ClientEvent, EventType, RelationType, RoomEvent, RoomStateEvent, type HierarchyRoom, type MatrixEvent, type Room } from "matrix-js-sdk";
import { addToSpace, canEditPacks, client, isDirect, roomPacks, removeFromSpace, seenBy, setRoomAvatar, spaceChildren } from "../matrix.ts";
import { matrixToLink, viaServers } from "../uri.ts";
import { usePresence, usePromise, useTick } from "../hooks.ts";
import { JOIN_RULES, normalize, num, spaceRooms, stamp } from "../logic.ts";
import { Icon } from "../icons.tsx";
import { Avatar, errText, me, RoomAvatar, roomAvatarMxc, Select, Sheet } from "./common.tsx";
import { useSlider } from "./useSlider.ts";
import { UserProfile } from "./Profile.tsx";
import { ChatForm, joinOrKnock, UserPicker } from "./NewChat.tsx";
import { isMuted, muteEnds, setMuted } from "../notify.ts";
import { PhotoViewer, SharedMedia } from "./Media.tsx";
import { BannedList, canManage, GroupSettings, KnockRequests, MemberRow, RoomDetails } from "./Admin.tsx";
import { alertDialog, confirmDialog } from "./dialog.tsx";
import { LinkSheet } from "./LinkSheet.tsx";
import { ReactionKey } from "./Emoji.tsx";
import { RoomPacks } from "./Packs.tsx";

/** Who the link actually lets in, by join rule (public needs no note). */
const JOIN_HINTS: Record<string, string> = {
  invite: "این گفتگو خصوصی است: با این پیوند فقط کسانی که دعوت شده‌اند می‌توانند بپیوندند.",
  knock: "با این پیوند می‌توان درخواست عضویت داد؛ مدیران آن را می‌پذیرند.",
  restricted: "فقط اعضای فضای مربوط می‌توانند با این پیوند بپیوندند.",
  knock_restricted: "اعضای فضای مربوط با این پیوند می‌پیوندند؛ بقیه درخواست عضویت می‌دهند.",
};

type View = "main" | "invite" | "add" | "new-group" | "settings" | "details" | "packs";

/** Chat/space info: profile, members, invite, space contents, leave. */
export function RoomInfo({ room, onClose }: { room: Room; onClose: () => void }) {
  useTick(client, [RoomStateEvent.Events, RoomStateEvent.Members, RoomEvent.Name, ClientEvent.Room, ClientEvent.AccountData, RoomEvent.AccountData]);
  useEffect(() => { room.loadMembersIfNeeded().catch(() => {}); }, [room]); // spaces open here without Room.tsx loading them
  const [view, setView] = useState<View>("main");
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<string | null>(null);
  const [media, setMedia] = useState(false);
  const [qr, setQr] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [q, setQ] = useState("");
  const closeViewer = useCallback(() => setViewing(false), []);
  const photo = roomAvatarMxc(room);
  const act = (fn: () => Promise<unknown>, then?: () => void) => {
    setBusy(true);
    fn().then(then, (e) => alertDialog(errText(e))).finally(() => setBusy(false));
  };

  const space = room.isSpaceRoom();
  const can = (type: string) => room.currentState.maySendStateEvent(type, me());
  const topic: string = room.currentState.getStateEvents(EventType.RoomTopic, "")?.getContent().topic ?? "";
  const members = room.getMembers().filter((m) => m.membership === "join" || m.membership === "invite")
    .sort((a, b) => +(a.membership === "invite") - +(b.membership === "invite") || b.powerLevel - a.powerLevel || a.name.localeCompare(b.name));
  const children = space ? spaceChildren(room.roomId) : [];
  // names, photos and sizes of the rooms I'm not in, from the server (only rooms it lets me preview are listed)
  const hierarchy = usePromise(useMemo(() => (space ? client.getRoomHierarchy(room.roomId, 50, 1)
    .then((r) => new Map(r.rooms.map((x) => [x.room_id, x])), () => new Map<string, HierarchyRoom>()) : null), [room.roomId, space, children.length]));
  const join = (id: string) => {
    const via: string[] | undefined = room.currentState.getStateEvents(EventType.SpaceChild, id)?.getContent().via;
    act(async () => {
      const r = await joinOrKnock(id, via);
      if (r && !r.isSpaceRoom()) { onClose(); location.hash = r.roomId; }
    });
  };
  const title = space ? "اطلاعات فضا" : "اطلاعات گفتگو";

  if (view === "invite") return (
    <Sheet title="دعوت اعضا" onClose={() => setView("main")}>
      <UserPicker exclude={members.map((m) => m.userId)} onPick={(p) => act(() => client.invite(room.roomId, p.userId), () => setView("main"))} />
    </Sheet>
  );
  if (view === "settings") return (
    <Sheet title={space ? "تنظیمات فضا" : "تنظیمات گروه"} onClose={() => setView("main")}>
      <GroupSettings room={room} onUser={setProfile} />
      {profile && <UserProfile userId={profile} room={room} onClose={() => setProfile(null)} onOpened={onClose} />}
    </Sheet>
  );
  if (view === "details") return (
    <Sheet title="اطلاعات فنی" onClose={() => setView("main")}>
      <RoomDetails room={room} onLeave={onClose} />
    </Sheet>
  );
  if (view === "packs") return (
    <Sheet title="اموجی و استیکر گفتگو" onClose={() => setView("main")}>
      <RoomPacks room={room} />
    </Sheet>
  );
  if (view === "new-group") return (
    <Sheet title="گروه جدید" onClose={() => setView("main")}>
      <ChatForm kind="group" space={room.roomId} onDone={(id) => { onClose(); location.hash = id; }} />
    </Sheet>
  );
  if (view === "add") {
    const inSpace = new Set(children);
    // visible = minus rooms replaced by an upgrade; a space that contains this one can't go inside it: that would be a loop
    const candidates = client.getVisibleRooms().filter((r) => r.getMyMembership() === "join" && r.roomId !== room.roomId && !inSpace.has(r.roomId)
      && !(r.isSpaceRoom() && spaceRooms(r.roomId, spaceChildren).has(room.roomId)));
    return (
      <Sheet title="افزودن گفتگو به فضا" onClose={() => setView("main")}>
        {candidates.length === 0 && <p className="muted">گفتگوی دیگری برای افزودن نیست</p>}
        {candidates.map((r) => (
          <button key={r.roomId} className="user-row" disabled={busy} onClick={() => act(() => addToSpace(room.roomId, r.roomId))}>
            <RoomAvatar room={r} size={42} /><span><b>{r.name}</b></span><Icon name="plus" />
          </button>
        ))}
      </Sheet>
    );
  }

  return (
    <Sheet key="main" title={title} onClose={onClose}>{/* key: a sub-view's Sheet sits in this same slot; reusing it would keep its "closing" state and leave the info stuck invisible */}
      <div className="info-head">
        {photo ? (
          <button className="avatar-view" onClick={() => setViewing(true)} title="نمایش عکس" aria-label="نمایش عکس"><RoomAvatar room={room} size={96} /></button>
        ) : <RoomAvatar room={room} size={96} />}
        {viewing && photo && <PhotoViewer mxc={photo} name={room.name} onClose={closeViewer} />}
        {can(EventType.RoomAvatar) && (
          <span>
            <label className="photo-remove photo-change">
              <input type="file" accept="image/*" hidden disabled={busy}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) act(() => setRoomAvatar(room.roomId, f)); }} />
              {room.getMxcAvatarUrl() ? "تغییر عکس" : "افزودن عکس"}
            </label>
            {room.getMxcAvatarUrl() && (
              <button className="photo-remove" disabled={busy} onClick={() => confirmDialog("عکس گفتگو حذف شود؟", { danger: true }).then((y) => y && act(() => client.sendStateEvent(room.roomId, EventType.RoomAvatar, {}, "")))}>حذف عکس</button>
            )}
          </span>
        )}
        {room.getCanonicalAlias() && <bdi dir="ltr" className="muted">{room.getCanonicalAlias()}</bdi>}
      </div>
      <Profile key={room.name + topic} room={room} topic={topic} editable={can(EventType.RoomName)} />
      {!space && (
        <MuteRow room={room} busy={busy} act={act} />
      )}
      {!space && <button className="user-row" onClick={() => setMedia(true)}><span className="device-box"><Icon name="file" /></span><span><b>رسانه‌ها، فایل‌ها و پیوندها</b></span></button>}
      {!isDirect(room) && (
        // an alias needs no via; a bare room id does, or people outside it can't join over federation
        <button className="user-row" onClick={() => setQr(true)}>
          <span className="device-box"><Icon name="link" /></span><span><b>{space ? "پیوند فضا" : "پیوند گفتگو"}</b><small>کپی، اشتراک‌گذاری و کد QR</small></span>
        </button>
      )}
      {(roomPacks(room).length > 0 || canEditPacks(room)) && (
        <button className="user-row" onClick={() => setView("packs")}>
          <span className="device-box"><Icon name="smile" /></span>
          <span><b>اموجی و استیکر گفتگو</b><small>{roomPacks(room).length ? `${num(roomPacks(room).length)} بسته` : "ساختن بسته برای اعضا"}</small></span>
        </button>
      )}
      {canManage(room) && (
        <button className="user-row" onClick={() => setView("settings")}>
          <span className="device-box"><Icon name="settings" /></span>
          <span><b>{space ? "تنظیمات فضا" : "تنظیمات گروه"}</b><small>{JOIN_RULES[room.getJoinRule()] ?? room.getJoinRule()}</small></span>
        </button>
      )}

      {space && (
        <>
          <h3>گفتگوهای این فضا ({num(children.length)})</h3>
          {can(EventType.SpaceChild) && (
            <div className="row-actions">
              <button onClick={() => setView("add")}><Icon name="plus" /> افزودن گفتگو</button>
              <button onClick={() => setView("new-group")}><Icon name="group" /> گروه جدید</button>
            </div>
          )}
          {children.map((id) => {
            const r = client.getRoom(id), joined = r?.getMyMembership() === "join", h = hierarchy?.get(id);
            const name = joined ? r.name : h?.name ?? h?.canonical_alias ?? r?.name ?? id;
            const suggested = room.currentState.getStateEvents(EventType.SpaceChild, id)?.getContent().suggested;
            return (
              <div key={id} className="user-row">
                {joined ? <RoomAvatar room={r} size={42} /> : <Avatar mxc={h?.avatar_url} name={name} id={id} size={42} />}
                <span>
                  <b>{name}</b>
                  <small>{[(r?.isSpaceRoom() || h?.room_type === "m.space") && "فضا", suggested && "پیشنهادی", !joined && (h ? `${num(h.num_joined_members)} عضو` : "عضو نیستید")].filter(Boolean).join(" · ")}</small>
                </span>
                {!joined && <button className="primary join-btn" disabled={busy} onClick={() => join(id)}>پیوستن</button>}
                {can(EventType.SpaceChild) && (
                  <button className="icon-btn" disabled={busy} title="حذف از فضا" aria-label="حذف از فضا"
                    onClick={() => act(() => removeFromSpace(room.roomId, id))}><Icon name="close" size={18} /></button>
                )}
              </div>
            );
          })}
        </>
      )}

      <KnockRequests room={room} onUser={setProfile} />
      <h3>اعضا ({num(room.getJoinedMemberCount())})</h3>
      {room.canInvite(me()) && <div className="row-actions"><button onClick={() => setView("invite")}><Icon name="plus" /> دعوت عضو</button></div>}
      <label className="search">
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجوی اعضا" aria-label="جستجوی اعضا" />
      </label>
      {members.filter((m) => normalize(m.name + " " + m.userId).includes(normalize(q.trim()))).map((m) => (
        <MemberRow key={m.userId} room={room} m={m} onUser={setProfile} sub={<><small dir="ltr">{m.userId}</small><LastSeen userId={m.userId} /></>} />
      ))}
      <BannedList room={room} onUser={setProfile} />
      <button className="user-row" onClick={() => setView("details")}>
        <span className="device-box"><Icon name="info" /></span><span><b>اطلاعات فنی</b><small>شناسه، نسخه و سازنده</small></span>
      </button>

      <button className="danger" disabled={busy}
        onClick={() => confirmDialog(space ? "از این فضا خارج می‌شوید؟" : "از این گفتگو خارج می‌شوید؟", { danger: true }).then((y) => y && act(() => client.leave(room.roomId), () => {
          if (location.hash.slice(1) === room.roomId) location.hash = "";
          onClose();
        }))}>
        {space ? "خروج از فضا" : "خروج از گفتگو"}
      </button>
      {profile && <UserProfile userId={profile} room={room} onClose={() => setProfile(null)} onOpened={onClose} />}
      {qr && (() => {
        const a = room.getCanonicalAlias();
        return <LinkSheet title={space ? "پیوند فضا" : "پیوند گفتگو"} onClose={() => setQr(false)} hint={JOIN_HINTS[room.getJoinRule()]}
          link={a ? matrixToLink(a) : matrixToLink(room.roomId, undefined, viaServers(room.getJoinedMembers().map((m) => m.userId)))} />;
      })()}
      {media && <SharedMedia room={room} onClose={() => setMedia(false)} onJump={onClose} />}
    </Sheet>
  );
}

/** Name + topic; editable fields save only what changed. Remounted (key) when the room's values change. */
/** Mute choices: hours, or until turned back on. Mentions still notify (they're server push rules above the room's). */
const MUTE_FOR: [string, string][] = [["on", "روشن"], ["1", "بی‌صدا ۱ ساعت"], ["8", "بی‌صدا ۸ ساعت"], ["24", "بی‌صدا ۱ روز"], ["168", "بی‌صدا ۱ هفته"], ["ever", "بی‌صدا تا روشن کردن"]];

function MuteRow({ room, busy, act }: { room: Room; busy: boolean; act: (fn: () => Promise<unknown>) => void }) {
  const muted = isMuted(room), until = muted ? muteEnds(room) : undefined;
  const options: [string, string][] = until ? [...MUTE_FOR, ["until", `بی‌صدا تا ${new Date(until).toLocaleString("fa-IR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}`]] : MUTE_FOR;
  return (
    <label className="select-row">اعلان‌ها
      <Select value={!muted ? "on" : until ? "until" : "ever"} options={options} disabled={busy}
        onChange={(v) => act(() => setMuted(room, v !== "on", Number(v) ? Date.now() + Number(v) * 3600_000 : undefined))} />
    </label>
  );
}

function Profile({ room, topic, editable }: { room: Room; topic: string; editable: boolean }) {
  // the explicit name, not room.name: that one is computed from members when there's none
  const current: string = room.currentState.getStateEvents(EventType.RoomName, "")?.getContent().name ?? "";
  const [name, setName] = useState(current);
  const [newTopic, setTopic] = useState(topic);
  const [busy, setBusy] = useState(false);
  if (!editable) return <div className="info-text"><h2>{room.name}</h2>{topic && <p>{topic}</p>}</div>;
  const dirty = name.trim() !== current || newTopic.trim() !== topic;
  const save = async () => {
    setBusy(true);
    try {
      if (name.trim() !== current) await client.setRoomName(room.roomId, name.trim()); // "" removes it
      if (newTopic.trim() !== topic) await client.setRoomTopic(room.roomId, newTopic.trim());
    } catch (e) {
      alertDialog(errText(e));
    }
    setBusy(false);
  };
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={current ? "نام" : room.name} aria-label="نام" />
      <input value={newTopic} onChange={(e) => setTopic(e.target.value)} placeholder="توضیحات" aria-label="توضیحات" />
      {dirty && <button className="primary" disabled={busy}>ذخیره</button>}
    </form>
  );
}

/** Who has read one of my messages, and when. */
export function SeenBy({ room, ev, onClose }: { room: Room; ev: MatrixEvent; onClose: () => void }) {
  useTick(client, [RoomEvent.Receipt]);
  const seen = seenBy(room, ev);
  const [profile, setProfile] = useState<string | null>(null);
  return (
    <Sheet title="دیده‌شده توسط" onClose={onClose}>
      {seen.length === 0 && <p className="muted">هنوز کسی ندیده</p>}
      {seen.map(({ userId, member, ts }) => (
        <button key={userId} className="user-row" onClick={() => setProfile(userId)}>
          <Avatar mxc={member?.getMxcAvatarUrl()} name={member?.name ?? userId} id={userId} size={42} />
          <span><b>{member?.name ?? userId}</b>{ts > 0 && <small>{stamp(ts)}</small>}</span>
          <Icon name="checks" size={18} />
        </button>
      ))}
      {profile && <UserProfile userId={profile} room={room} onClose={() => setProfile(null)} onOpened={onClose} />}
    </Sheet>
  );
}

/** Who reacted to a message, with what; one tab per emoji when there are several. */
export function ReactedBy({ room, ev, onClose }: { room: Room; ev: MatrixEvent; onClose: () => void }) {
  useTick(client, [RoomEvent.Timeline, RoomEvent.Redaction]);
  const [key, setKey] = useState<string | null>(null); // null = all
  const pill = useSlider<HTMLDivElement>();
  const [profile, setProfile] = useState<string | null>(null);
  const groups = (room.relations.getChildEventsForEvent(ev.getId()!, RelationType.Annotation, EventType.Reaction)
    ?.getSortedAnnotationsByKey() ?? []).filter(([, set]) => set.size > 0);
  const rows = groups.filter(([k]) => key === null || k === key)
    .flatMap(([k, set]) => [...set].filter((e) => !e.isRedacted()).map((e) => ({ k, e })));
  return (
    <Sheet title="واکنش‌ها" onClose={onClose}>
      {groups.length > 1 && (
        <div className="segmented reacted-tabs" data-pill ref={pill}>
          <button className={key === null ? "on" : ""} onClick={() => setKey(null)}>همه {num(groups.reduce((n, [, set]) => n + set.size, 0))}</button>
          {groups.map(([k, set]) => <button key={k} className={key === k ? "on" : ""} onClick={() => setKey(k)}><ReactionKey k={k} ev={[...set][0]} /> {num(set.size)}</button>)}
        </div>
      )}
      {rows.length === 0 && <p className="muted">واکنشی نیست</p>}
      {rows.map(({ k, e }) => {
        const id = e.getSender()!, m = room.getMember(id);
        return (
          <button key={e.getId()} className="user-row" onClick={() => setProfile(id)}>
            <Avatar mxc={m?.getMxcAvatarUrl()} name={m?.name ?? id} id={id} size={42} />
            <span><b>{m?.name ?? id}</b><small>{stamp(e.getTs())}</small></span>
            <span className="reacted-key"><ReactionKey k={k} ev={e} /></span>
          </button>
        );
      })}
      {profile && <UserProfile userId={profile} room={room} onClose={() => setProfile(null)} onOpened={onClose} />}
    </Sheet>
  );
}

/** Member-row last seen (cached /presence lookups). */
function LastSeen({ userId }: { userId: string }) {
  const { text, online } = usePresence(userId === me() ? undefined : userId);
  return text ? <small className={online ? "typing" : undefined}>{text}</small> : null;
}
