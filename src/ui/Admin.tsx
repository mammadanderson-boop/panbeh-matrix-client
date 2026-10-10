import { useEffect, useState, type ReactNode } from "react";
import { EventTimeline, EventType, RoomEvent, RoomStateEvent, Visibility, type Room, type RoomMember } from "matrix-js-sdk";
import { client, spaceChildren } from "../matrix.ts";
import { useTick } from "../hooks.ts";
import { aliasLocalpart, HISTORY, JOIN_RULES, levelAt, levelOptions, normalize, num, roleLabel, supportsKnock, supportsKnockRestricted, supportsRestricted, withLevel, type PowerLevels } from "../logic.ts";
import { Icon } from "../icons.tsx";
import { Avatar, ContextMenu, errText, me, Select, Sheet } from "./common.tsx";
import { useLongPress } from "./useLongPress.ts";
import { alertDialog, confirmDialog, promptDialog } from "./dialog.tsx";

const STATE = [RoomStateEvent.Events, RoomStateEvent.Members];

/** busy flag + run-and-alert, as in RoomInfo */
function useAct() {
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>, then?: () => void) => {
    setBusy(true);
    fn().then(then, (e) => alertDialog(errText(e))).finally(() => setBusy(false));
  };
  return [busy, act] as const;
}

const levels = (room: Room): PowerLevels => room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() ?? {};
/** The member's level as the SDK computes it: from room v12 on, creators aren't in `users` and outrank everyone (Infinity). */
const levelOf = (room: Room, id: string) => {
  const pl = levels(room);
  return room.getMember(id)?.powerLevel ?? pl.users?.[id] ?? pl.users_default ?? 0;
};

/** null on cancel, undefined for an empty reason */
const askReason = (q: string) => promptDialog(q, { danger: true, placeholder: "دلیل (اختیاری)" }).then((r) => (r === null ? null : r || undefined));

const ROLES: [number, string][] = [[0, "عضو"], [50, "ناظر"], [100, "مدیر"]];
const WHO: [number, string][] = [[0, "همه‌ی اعضا"], [50, "ناظران و مدیران"], [100, "فقط مدیران"]];

// ---------- one member: role, kick, ban ----------

/** What I may do to someone I outrank; null if nothing (or it's me, or they're my rank or above). */
export function memberOps(room: Room, userId: string) {
  if (userId === me() || room.getMyMembership() !== "join") return null;
  const pl = levels(room), mine = levelOf(room, me()), theirs = levelOf(room, userId);
  if (theirs >= mine) return null;
  const membership = room.getMember(userId)?.membership;
  const mayKick = mine >= levelAt(pl, "kick") && (membership === "join" || membership === "invite");
  const mayBan = mine >= levelAt(pl, "ban");
  const mayRole = membership !== "ban" && room.currentState.maySendStateEvent(EventType.RoomPowerLevels, me());
  if (!mayKick && !mayBan && !mayRole) return null;
  return {
    membership, theirs, mayKick, mayBan, mayRole,
    roles: levelOptions(ROLES, mine, theirs),
    setRole: async (l: number) => {
      // same level as mine can't be undone by me
      if (l >= mine && !(await confirmDialog("هم‌سطح شما می‌شود و دیگر نمی‌توانید نقشش را تغییر دهید یا بیرونش کنید. ادامه می‌دهید؟", { danger: true }))) return;
      await client.setPowerLevel(room.roomId, userId, l);
    },
    kick: async () => {
      const r = await askReason(membership === "invite" ? "دعوت لغو شود؟" : "از گفتگو بیرون شود؟");
      if (r !== null) await client.kick(room.roomId, userId, r);
    },
    ban: async () => {
      const r = await askReason("مسدود شود؟ دیگر نمی‌تواند بپیوندد.");
      if (r !== null) await client.ban(room.roomId, userId, r);
    },
    unban: () => client.unban(room.roomId, userId),
  };
}

/** Admin actions on someone I outrank, in their profile; nothing otherwise. */
export function MemberAdmin({ room, userId }: { room: Room; userId: string }) {
  useTick(client, STATE);
  const [busy, act] = useAct();
  const ops = memberOps(room, userId);
  if (!ops) return null;
  return (
    <div className="admin">
      <h3>مدیریت در این گفتگو</h3>
      {ops.mayRole && (
        <label className="select-row">نقش
          <Select value={ops.theirs} disabled={busy} options={ops.roles} onChange={(l) => act(() => ops.setRole(l))} />
        </label>
      )}
      <div className="row-actions">
        {ops.mayKick && <button className="warn" disabled={busy} onClick={() => act(ops.kick)}>{ops.membership === "invite" ? "لغو دعوت" : "بیرون کردن"}</button>}
        {ops.mayBan && (ops.membership === "ban"
          ? <button disabled={busy} onClick={() => act(ops.unban)}>رفع مسدودیت در گروه</button>
          : <button className="warn" disabled={busy} onClick={() => act(ops.ban)}>مسدود در این گروه</button>)}
      </div>
    </div>
  );
}

/** The same actions as a long-press / right-click menu. */
function MemberMenu({ room, userId, x, y, onClose, onProfile }: { room: Room; userId: string; x: number; y: number; onClose: () => void; onProfile: () => void }) {
  const ops = memberOps(room, userId);
  const run = (fn: () => Promise<unknown>) => { onClose(); fn().catch((e) => alertDialog(errText(e))); };
  return (
    <ContextMenu x={x} y={y} target=".member-row" onClose={onClose}>
      {ops?.mayRole && ops.roles.map(([l, label]) => (
        <button key={l} role="menuitemradio" aria-checked={l === ops.theirs} onClick={() => (l === ops.theirs ? onClose() : run(() => ops.setRole(l)))}>
          <span className="menu-check">{l === ops.theirs && <Icon name="check" />}</span> {label}</button>
      ))}
      {ops?.mayKick && (
        <button role="menuitem" className="danger-item" onClick={() => run(ops.kick)}><Icon name="close" /> {ops.membership === "invite" ? "لغو دعوت" : "بیرون کردن"}</button>
      )}
      {ops?.mayBan && (ops.membership === "ban"
        ? <button role="menuitem" onClick={() => run(ops.unban)}><Icon name="check" /> رفع مسدودیت</button>
        : <button role="menuitem" className="danger-item" onClick={() => run(ops.ban)}><Icon name="flag" /> مسدود کردن</button>)}
      <button role="menuitem" onClick={() => { onClose(); onProfile(); }}><Icon name="info" /> اطلاعات کاربر</button>
    </ContextMenu>
  );
}

/** A member in a list: tap = profile (or the menu, with `tapMenu`), long-press / right-click = admin menu when I have any. */
export function MemberRow({ room, m, sub, onUser, tapMenu }: { room: Room; m: RoomMember; sub?: ReactNode; onUser: (id: string) => void; tapMenu?: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const ops = memberOps(room, m.userId);
  const { click, handlers } = useLongPress(ops ? (x, y) => setMenu({ x, y }) : undefined);
  const role = roleLabel(m.powerLevel);
  return (
    <>
      <button className="user-row member-row" {...handlers}
        onClick={tapMenu && ops ? (e) => setMenu({ x: e.clientX, y: e.clientY }) : click(() => onUser(m.userId))}>
        <Avatar mxc={m.getMxcAvatarUrl()} name={m.name} id={m.userId} size={42} />
        <span><b>{m.name}</b>{sub}</span>
        {m.membership === "invite" ? <em className="muted">دعوت‌شده</em> : role && <em>{role}</em>}
      </button>
      {menu && <MemberMenu room={room} userId={m.userId} {...menu} onClose={() => setMenu(null)} onProfile={() => onUser(m.userId)} />}
    </>
  );
}

// ---------- RoomInfo lists: knocks and bans ----------

export function KnockRequests({ room, onUser }: { room: Room; onUser: (id: string) => void }) {
  useTick(client, STATE);
  const [busy, act] = useAct();
  const knocks = room.getMembersWithMembership("knock");
  if (!knocks.length || !room.canInvite(me())) return null;
  const mayDeny = levelOf(room, me()) >= levelAt(levels(room), "kick");
  return (
    <>
      <h3>درخواست‌های عضویت ({num(knocks.length)})</h3>
      {knocks.map((m) => (
        <div key={m.userId} className="user-row">
          <button className="plain" onClick={() => onUser(m.userId)} aria-label={m.name}><Avatar mxc={m.getMxcAvatarUrl()} name={m.name} id={m.userId} size={42} /></button>
          <span><b>{m.name}</b><small dir="auto">{m.events.member?.getContent().reason || m.userId}</small></span>
          {mayDeny && <button className="icon-btn" disabled={busy} title="رد" aria-label="رد" onClick={() => act(() => client.kick(room.roomId, m.userId))}><Icon name="close" size={18} /></button>}
          <button className="icon-btn accent" disabled={busy} title="پذیرفتن" aria-label="پذیرفتن" onClick={() => act(() => client.invite(room.roomId, m.userId))}><Icon name="check" size={18} /></button>
        </div>
      ))}
    </>
  );
}

export function BannedList({ room, onUser }: { room: Room; onUser: (id: string) => void }) {
  useTick(client, STATE);
  const banned = room.getMembersWithMembership("ban");
  if (!banned.length) return null;
  return (
    <>
      <h3>مسدودشده‌ها ({num(banned.length)})</h3>
      {banned.map((m) => (
        <MemberRow key={m.userId} room={room} m={m} onUser={onUser}
          sub={<small>{m.events.member?.getContent().reason || <bdi dir="ltr">{m.userId}</bdi>}</small>} />
      ))}
    </>
  );
}

// ---------- group settings ----------

/** Anything in GroupSettings I'm allowed to change. */
export function canManage(room: Room) {
  const can = (t: string) => room.currentState.maySendStateEvent(t, me());
  return can(EventType.RoomJoinRules) || can(EventType.RoomCanonicalAlias) || can(EventType.RoomPowerLevels)
    || (!room.isSpaceRoom() && (can(EventType.RoomHistoryVisibility) || (can(EventType.RoomEncryption) && !room.hasEncryptionStateEvent())));
}

/** The space a "space members" join rule points at: the one it already names, else a joined space listing this room.
 *  ponytail: one space only; the allow list can name several. */
function parentSpace(room: Room) {
  const allowed = room.currentState.getStateEvents(EventType.RoomJoinRules, "")?.getContent().allow
    ?.find((a: { type?: string }) => a.type === "m.room_membership")?.room_id;
  const spaces = client.getRooms().filter((s) => s.isSpaceRoom() && s.getMyMembership() === "join" && s.roomId !== room.roomId);
  return spaces.find((s) => s.roomId === allowed) ?? spaces.find((s) => spaceChildren(s.roomId).includes(room.roomId));
}

/** Members above the default level, highest first. */
const adminsOf = (room: Room) => {
  const base = levels(room).users_default ?? 0;
  return room.getMembers().filter((m) => m.membership === "join" && m.powerLevel > base)
    .sort((a, b) => b.powerLevel - a.powerLevel || a.name.localeCompare(b.name));
};

export function GroupSettings({ room, onUser }: { room: Room; onUser: (id: string) => void }) {
  useTick(client, STATE);
  const [busy, act] = useAct();
  const [page, setPage] = useState<"admins" | "permissions" | null>(null);
  const can = (t: string) => room.currentState.maySendStateEvent(t, me());
  const send = (type: string, content: object) => act(() => client.sendStateEvent(room.roomId, type as never, content as never, ""));
  const space = room.isSpaceRoom();
  const rule = room.getJoinRule(), v = room.getVersion();
  const parent = parentSpace(room);
  const rules = ["public", "invite", ...(supportsKnock(v) ? ["knock"] : []),
    ...(parent && supportsRestricted(v) ? ["restricted"] : []), ...(parent && supportsKnockRestricted(v) ? ["knock_restricted"] : [])];
  if (!rules.includes(rule)) rules.push(rule);
  const ruleLabel = (r: string) => (!parent || !r.endsWith("restricted") ? JOIN_RULES[r] ?? r
    : r === "restricted" ? `اعضای فضای «${parent.name}»` : `اعضای فضای «${parent.name}»، یا با درخواست عضویت`);
  const setRule = (r: string) => send(EventType.RoomJoinRules, r.endsWith("restricted") && parent
    ? { join_rule: r, allow: [{ type: "m.room_membership", room_id: parent.roomId }] } : { join_rule: r });
  const history = room.getHistoryVisibility();

  return (
    <div className="form">
      {can(EventType.RoomPowerLevels) && (
        <>
          <button type="button" className="user-row" onClick={() => setPage("admins")}>
            <span className="device-box"><Icon name="user" /></span><span><b>مدیران</b><small>{num(adminsOf(room).length)} نفر</small></span>
          </button>
          <button type="button" className="user-row" onClick={() => setPage("permissions")}>
            <span className="device-box"><Icon name="lock" /></span><span><b>دسترسی‌ها</b><small>چه کسی چه کاری می‌تواند بکند</small></span>
          </button>
        </>
      )}
      {page === "admins" && <Sheet title="مدیران" onClose={() => setPage(null)}><Admins room={room} onUser={onUser} /></Sheet>}
      {page === "permissions" && <Sheet title="دسترسی‌ها" onClose={() => setPage(null)}><Permissions room={room} /></Sheet>}
      {can(EventType.RoomJoinRules) && (
        <label className="select-row">پیوستن
          <Select value={rule} disabled={busy} options={rules.map((r) => [r, ruleLabel(r)])} onChange={setRule} />
        </label>
      )}
      {!space && can(EventType.RoomHistoryVisibility) && (
        <label className="select-row">چه کسی تاریخچه را می‌بیند
          <Select value={history} disabled={busy} options={Object.entries(HISTORY)}
            onChange={(v) => send(EventType.RoomHistoryVisibility, { history_visibility: v })} />
        </label>
      )}
      {!space && (room.hasEncryptionStateEvent()
        ? <p className="card ok"><Icon name="lock" size={16} /> رمزنگاری سرتاسری روشن است</p>
        : can(EventType.RoomEncryption) && (
          <div className="row-actions">
            <button disabled={busy} onClick={() => confirmDialog("رمزنگاری سرتاسری پس از روشن شدن خاموش نمی‌شود و جستجوی سرور و ربات‌ها شاید دیگر کار نکنند. روشن شود؟", { danger: true })
              .then((y) => y && send(EventType.RoomEncryption, { algorithm: "m.megolm.v1.aes-sha2" }))}>
              <Icon name="lock" size={16} /> روشن کردن رمزنگاری سرتاسری
            </button>
          </div>
        ))}
      {can(EventType.RoomCanonicalAlias) && <Address room={room} />}
    </div>
  );
}

/** Admins and moderators; tapping one opens the role menu. "Add" lists the other members the same way. */
function Admins({ room, onUser }: { room: Room; onUser: (id: string) => void }) {
  useTick(client, STATE);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const admins = adminsOf(room);
  const others = room.getMembers().filter((m) => m.membership === "join" && !admins.includes(m) && m.userId !== me()
    && normalize(m.name + " " + m.userId).includes(normalize(q.trim())));
  return (
    <>
      {admins.map((m) => <MemberRow key={m.userId} room={room} m={m} onUser={onUser} tapMenu sub={<small dir="ltr">{m.userId}</small>} />)}
      <div className="row-actions"><button onClick={() => setAdding(true)}><Icon name="plus" /> افزودن مدیر</button></div>
      {adding && (
        <Sheet title="افزودن مدیر" onClose={() => setAdding(false)}>
          <label className="search">
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجوی اعضا" aria-label="جستجوی اعضا" autoFocus />
          </label>
          {others.length === 0 && <p className="muted">عضو دیگری نیست</p>}
          {others.map((m) => <MemberRow key={m.userId} room={room} m={m} onUser={onUser} tapMenu sub={<small dir="ltr">{m.userId}</small>} />)}
        </Sheet>
      )}
    </>
  );
}

/** Who may do what: one role select per action. Keys are levelAt's; several keys move together. */
const PERMS: [string, string[]][] = [
  ["ارسال پیام", ["events_default"]],
  ["دعوت اعضا", ["invite"]],
  ["بیرون کردن", ["kick"]],
  ["مسدود کردن", ["ban"]],
  ["حذف پیام دیگران", ["redact"]],
  ["تغییر نام، عکس و توضیحات", ["events.m.room.name", "events.m.room.avatar", "events.m.room.topic"]],
  ["سنجاق پیام", ["events.m.room.pinned_events"]],
  ["نام بردن از همه (‎@room)", ["notifications.room"]],
  ["تماس گروهی", [`events.${EventType.GroupCallMemberPrefix}`]],
];
const SPACE_PERMS: [string, string[]][] = [
  ["افزودن گفتگو به فضا", ["events.m.space.child"]],
  ["دعوت اعضا", ["invite"]],
  ["بیرون کردن", ["kick"]],
  ["مسدود کردن", ["ban"]],
  ["تغییر نام، عکس و توضیحات", ["events.m.room.name", "events.m.room.avatar", "events.m.room.topic"]],
];

function Permissions({ room }: { room: Room }) {
  useTick(client, STATE);
  const [busy, act] = useAct();
  const pl = levels(room), mine = levelOf(room, me());
  const set = (keys: string[], l: number) =>
    act(() => client.sendStateEvent(room.roomId, EventType.RoomPowerLevels, keys.reduce((c, k) => withLevel(c, k, l), levels(room)) as never, ""));
  return (
    <div className="form">
      {(room.isSpaceRoom() ? SPACE_PERMS : PERMS).map(([label, keys]) => {
        const cur = levelAt(pl, keys[0]);
        // the server refuses changing a setting that's above my own level
        const locked = keys.some((k) => levelAt(pl, k) > mine);
        return (
          <label key={label} className="select-row">{label}
            <Select value={cur} disabled={busy || locked} options={levelOptions(WHO, mine, cur)} onChange={(l) => set(keys, l)} />
          </label>
        );
      })}
    </div>
  );
}

/** Canonical #alias (create/remove) and listing in the server's public directory. */
function Address({ room }: { room: Room }) {
  const [busy, act] = useAct();
  const alias = room.getCanonicalAlias();
  const [lp, setLp] = useState(() => aliasLocalpart(room.name));
  const [listed, setListed] = useState<boolean | null>(null);
  useEffect(() => {
    client.getRoomDirectoryVisibility(room.roomId).then((r) => setListed(r.visibility === Visibility.Public), () => {});
  }, [room.roomId]);
  const content = () => room.currentState.getStateEvents(EventType.RoomCanonicalAlias, "")?.getContent() ?? {};
  const setCanonical = (a?: string) => {
    const { alias: _, ...rest } = content();
    return client.sendStateEvent(room.roomId, EventType.RoomCanonicalAlias, (a ? { ...rest, alias: a } : rest) as never, "");
  };
  const add = async () => {
    const a = `#${lp}:${client.getDomain()}`;
    await client.createAlias(a, room.roomId);
    await setCanonical(a);
  };
  const remove = async () => {
    await setCanonical();
    await client.deleteAlias(alias!).catch(() => {}); // may belong to someone else or another server
  };

  return (
    <>
      <h3>نشانی عمومی</h3>
      {alias ? (
        <div className="user-row">
          <span className="device-box"><Icon name="link" /></span>
          <span><b dir="ltr">{alias}</b></span>
          <button className="icon-btn" disabled={busy} title="حذف نشانی" aria-label="حذف نشانی" onClick={() => confirmDialog("نشانی حذف شود؟", { danger: true }).then((y) => y && act(remove))}><Icon name="trash" size={18} /></button>
        </div>
      ) : (
        <form className="alias-input" dir="ltr" onSubmit={(e) => { e.preventDefault(); act(add); }}>
          <span>#</span>
          <input value={lp} onChange={(e) => setLp(e.target.value.replace(/[\s:#]/g, ""))} placeholder="address" required />
          <span>:{client.getDomain()}</span>
          <button className="accent-btn" disabled={busy}>ثبت</button>
        </form>
      )}
      {listed !== null && (
        <label className="switch-row"><span>در فهرست گفتگوهای عمومی<small>دیگران با جستجو پیدایش می‌کنند</small></span>
          <input type="checkbox" role="switch" checked={listed} disabled={busy}
            onChange={(e) => { const on = e.target.checked; act(() => client.setRoomDirectoryVisibility(room.roomId, on ? Visibility.Public : Visibility.Private), () => setListed(on)); }} /></label>
      )}
    </>
  );
}

// ---------- room upgrades ----------

/** A tombstoned room takes no messages: the composer becomes a link to the new room. A room where I may not post gets a notice instead. */
export function Upgraded({ room, children }: { room: Room; children: ReactNode }) {
  useTick(client, STATE);
  const [busy, act] = useAct();
  const ev = room.currentState.getStateEvents(EventType.RoomTombstone, "");
  if (!ev) {
    if (room.currentState.maySendEvent(EventType.RoomMessage, me())) return children;
    return <div className="upgraded"><span>فقط مدیران می‌توانند در این گروه پیام بفرستند</span></div>;
  }
  const to: string | undefined = ev.getContent().replacement_room;
  const go = async () => {
    // the upgrader's server is in the new room for sure
    if (client.getRoom(to!)?.getMyMembership() !== "join") await client.joinRoom(to!, { viaServers: [ev.getSender()!.replace(/^[^:]*:/, "")] });
    location.hash = to!;
  };
  return (
    <div className="upgraded">
      <span>این گروه ارتقا یافته و دیگر پیامی در آن فرستاده نمی‌شود</span>
      {to && <button className="primary" disabled={busy} onClick={() => act(go)}>رفتن به گروه جدید</button>}
    </div>
  );
}

/** Link back to the room this one replaced, once its start is reached. */
export function Predecessor({ room }: { room: Room }) {
  useTick(client, [RoomEvent.Timeline, RoomEvent.TimelineReset]);
  const pred = room.findPredecessor();
  const old = pred && client.getRoom(pred.roomId);
  // ponytail: only rooms we're still in; joining a left predecessor needs via servers we may not have
  if (!old || old.getMyMembership() !== "join" || room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS)) return null;
  return <button className="predecessor" onClick={() => { location.hash = old.roomId; }}>ادامه‌ی گروه قبلی؛ دیدن پیام‌های قدیمی‌تر</button>;
}
