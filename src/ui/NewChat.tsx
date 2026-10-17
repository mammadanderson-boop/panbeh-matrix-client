import { t } from "../i18n.ts";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { EventType, type IPublicRoomsChunkRoom, type Room } from "matrix-js-sdk";
import { addToSpace, client, createChat, openDM } from "../matrix.ts";
import { aliasLocalpart, isUserId, num, supportsRestricted } from "../logic.ts";
import { usePromise } from "../hooks.ts";
import { Icon, type IconName } from "../icons.tsx";
import { Avatar, errText, me, Select, Sheet, toast } from "./common.tsx";
import { alertDialog, confirmDialog, editAvatar } from "./dialog.tsx";
import { useExit } from "./useDismiss.ts";

type Kind = "dm" | "group" | "space" | "join";
const MENU: [Kind, IconName, string][] = [
  ["dm", "user", t("new.dm")],
  ["group", "group", t("new.group")],
  ["space", "space", t("new.space")],
  ["join", "link", t("new.join")],
];
const TITLES = Object.fromEntries(MENU.map(([k, , t]) => [k, t])) as Record<Kind, string>;

/** Floating pencil button + menu; each item opens its own sheet.
 *  `onOpen(id, true)` = a space: shown as a folder, not opened as a chat. */
export function NewChat({ activeSpace, onOpen }: { activeSpace?: string; onOpen: (roomId: string, space: boolean) => void }) {
  const [menu, setMenu] = useState(false);
  const [menuShown, menuClosing] = useExit(menu);
  const [kind, setKind] = useState<Kind | null>(null);
  const done = (id: string, space = kind === "space") => { setKind(null); onOpen(id, space); };
  return (
    <>
      {menuShown && (
        <div className={"fab-backdrop" + (menuClosing ? " closing" : "")} onClick={() => setMenu(false)} onKeyDown={(e) => e.key === "Escape" && setMenu(false)}>
          <div className="fab-menu" role="menu">
            {MENU.map(([k, icon, label]) => (
              <button key={k} role="menuitem" onClick={() => { setKind(k); setMenu(false); }}><Icon name={icon} /> {label}</button>
            ))}
          </div>
        </div>
      )}
      <button className={"fab" + (menu ? " open" : "")} onClick={() => setMenu((m) => !m)} aria-label={t("new.chat")} title={t("new.chat")}>
        <Icon name={menu ? "close" : "pencil"} size={24} />
      </button>
      {kind && (
        <Sheet title={TITLES[kind]} onClose={() => setKind(null)}>
          {kind === "dm" ? <NewDM onDone={done} />
            : kind === "join" ? <JoinChat onDone={done} />
            : <ChatForm kind={kind} space={activeSpace} onDone={done} />}
        </Sheet>
      )}
    </>
  );
}

function NewDM({ onDone }: { onDone: (roomId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const pick = (p: Person) => {
    setBusy(true);
    openDM(p.userId).then(onDone, (e) => { alertDialog(errText(e)); setBusy(false); });
  };
  return busy ? <p className="muted">{t("new.creatingChat")}</p> : <UserPicker onPick={pick} />;
}

// ---------- user search ----------

export type Person = { userId: string; name: string; avatar?: string };

/** Search the user directory; a full @user:server is also looked up directly, since some servers
 *  (Conduit) only list users you already share a room with. */
export function UserPicker({ onPick, exclude = [], autoFocus = true }: { onPick: (p: Person) => void; exclude?: string[]; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Person[] | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      const [dir, direct] = await Promise.all([
        client.searchUserDirectory({ term, limit: 20 }).then((r) => r.results, () => []),
        isUserId(term)
          ? client.getProfileInfo(term).then(
            (p) => ({ userId: term, name: p.displayname ?? term, avatar: p.avatar_url }),
            // unknown user = drop it; other failures (e.g. profile lookups disabled) still let you try the ID
            (e) => (e?.errcode === "M_NOT_FOUND" ? null : { userId: term, name: term }))
          : null,
      ]);
      const people: Person[] = dir.map((u) => ({ userId: u.user_id, name: u.display_name ?? u.user_id, avatar: u.avatar_url }));
      if (direct && !people.some((p) => p.userId === direct.userId)) people.unshift(direct);
      if (live) setResults(people);
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const hide = new Set([me(), ...exclude]);
  const shown = results?.filter((p) => !hide.has(p.userId));
  return (
    <div className="picker">
      <label className="search">
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("new.userPlaceholder")} aria-label={t("new.searchUser")} autoFocus={autoFocus} />
      </label>
      {shown?.length === 0 && <p className="muted">{t("new.noUser")}</p>}
      {shown?.map((p) => (
        <button key={p.userId} type="button" className="user-row" onClick={() => { onPick(p); setQ(""); }}>
          <Avatar mxc={p.avatar} name={p.name} id={p.userId} size={42} />
          <span><b>{p.name}</b><small dir="ltr">{p.userId}</small></span>
        </button>
      ))}
    </div>
  );
}

// ---------- new group / space ----------

export function ChatForm({ kind, space, onDone }: { kind: "group" | "space"; space?: string; onDone: (roomId: string) => void }) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [invite, setInvite] = useState<Person[]>([]);
  const [isPublic, setPublic] = useState(false);
  const [alias, setAlias] = useState("");
  const [encrypted, setEncrypted] = useState(true);
  const spaces = client.getRooms().filter((r) => r.isSpaceRoom() && r.getMyMembership() === "join" &&
    r.currentState.maySendStateEvent(EventType.SpaceChild, me()));
  // the open folder only if I may add rooms to it: otherwise the picker hides it, yet it would still be used
  const [parent, setParent] = useState(() => (spaces.some((s) => s.roomId === space) ? space! : ""));
  const [spaceJoin, setSpaceJoin] = useState(true);
  // the room gets the server's default version, which must know the "restricted" join rule
  const caps = usePromise(useMemo(() => client.getCapabilities().catch(() => undefined), []));
  const canRestrict = !!parent && !isPublic && supportsRestricted(caps?.["m.room_versions"]?.default);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const preview = useObjectUrl(avatar);

  function togglePublic(on: boolean) {
    setPublic(on);
    setEncrypted(!on); // public rooms are readable by anyone who joins; encryption only slows them down
    if (on && !alias) setAlias(aliasLocalpart(name));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const id = await createChat({
        kind, name: name.trim(), topic: topic.trim(), avatar, invite: invite.map((p) => p.userId),
        encrypted, alias: isPublic ? alias.trim() : undefined, restrictTo: canRestrict && spaceJoin ? parent : undefined,
      });
      // the room exists now: a failure here mustn't look like the whole thing failed, or a retry makes a duplicate
      if (parent) await addToSpace(parent, id).catch(() => toast(t("new.notAddedToSpace")));
      onDone(id);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-head">
        <label className="avatar-pick" title={t("new.pickPhoto")}>
          <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void editAvatar(f).then((a) => a && setAvatar(a)); }} />
          {preview ? <img src={preview} alt="" /> : <Icon name={kind === "space" ? "space" : "group"} size={28} />}
        </label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "space" ? t("new.spaceName") : t("new.groupName")} required autoFocus />
      </div>
      <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t("new.topic")} />

      <label className="switch-row"><span>{t("new.public")}<small>{t("new.publicHint")}</small></span>
        <input type="checkbox" role="switch" checked={isPublic} onChange={(e) => togglePublic(e.target.checked)} /></label>
      {isPublic && (
        <div className="alias-input" dir="ltr">
          <span>#</span>
          <input value={alias} onChange={(e) => setAlias(e.target.value.replace(/[\s:#]/g, ""))} placeholder="address" required />
          <span>:{client.getDomain()}</span>
        </div>
      )}
      {kind === "group" && (
        <label className="switch-row"><span>{t("new.e2ee")}<small>{t("new.e2eeHint")}</small></span>
          <input type="checkbox" role="switch" checked={encrypted} onChange={(e) => setEncrypted(e.target.checked)} /></label>
      )}
      {spaces.length > 0 && (
        <label className="select-row">{t("new.inSpace")}
          <Select value={parent} options={[["", t("common.none")], ...spaces.map((s): [string, string] => [s.roomId, s.name])]} onChange={setParent} />
        </label>
      )}
      {canRestrict && (
        <label className="switch-row"><span>{t("new.spaceMembersJoin")}<small>{t("new.spaceMembersJoinHint")}</small></span>
          <input type="checkbox" role="switch" checked={spaceJoin} onChange={(e) => setSpaceJoin(e.target.checked)} /></label>
      )}

      <h3>{t("new.members")} {invite.length > 0 && `(${num(invite.length)})`}</h3>
      {invite.length > 0 && (
        <div className="chips">
          {invite.map((p) => (
            <button key={p.userId} type="button" className="chip" onClick={() => setInvite(invite.filter((x) => x !== p))} title={t("common.delete")}>
              <Avatar mxc={p.avatar} name={p.name} id={p.userId} size={24} /> {p.name} <Icon name="close" size={14} />
            </button>
          ))}
        </div>
      )}
      <UserPicker exclude={invite.map((p) => p.userId)} onPick={(p) => setInvite([...invite, p])} autoFocus={false} />

      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? t("new.creating") : kind === "space" ? t("new.createSpace") : t("new.createGroup")}</button>
    </form>
  );
}

function useObjectUrl(file: File | null) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) { setUrl(undefined); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

// ---------- join by address / directory ----------

/** Joins; a room that refuses (knock-only or invite-only) gets an offer to ask to be let in. Null = not joined, already told. */
export async function joinOrKnock(idOrAlias: string, via?: string[]): Promise<Room | null> {
  try {
    return await client.joinRoom(idOrAlias, { viaServers: via });
  } catch (e) {
    if ((e as { errcode?: string })?.errcode !== "M_FORBIDDEN") alertDialog(errText(e));
    else if (await confirmDialog(t("new.knockQ"))) {
      try {
        await client.knockRoom(idOrAlias, { viaServers: via });
        alertDialog(t("new.knockSent"));
      } catch (e2) { alertDialog((e2 as { errcode?: string }).errcode === "M_FORBIDDEN" ? t("new.noKnock") : errText(e2)); }
    }
    return null;
  }
}

function JoinChat({ onDone }: { onDone: (roomId: string, space: boolean) => void }) {
  const [q, setQ] = useState("");
  const [rooms, setRooms] = useState<IPublicRoomsChunkRoom[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      const term = q.trim();
      client.publicRooms({ limit: 30, filter: term && !/^[#!]/.test(term) ? { generic_search_term: term } : undefined })
        .then((r) => live && setRooms(r.chunk), () => live && setRooms([]));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const join = (idOrAlias: string, space = false) => {
    setBusy(true);
    joinOrKnock(idOrAlias).then((r) => (r ? onDone(r.roomId, space || r.isSpaceRoom()) : setBusy(false)));
  };
  const joined = (id: string) => client.getRoom(id)?.getMyMembership() === "join";
  const address = /^[#!]\S+:\S+$/.test(q.trim());

  return (
    <div className="picker">
      <form className="search" onSubmit={(e) => { e.preventDefault(); if (address) join(q.trim()); }}>
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("new.roomPlaceholder")} aria-label={t("new.searchRoom")} autoFocus />
      </form>
      {address && <button className="primary" disabled={busy} onClick={() => join(q.trim())}>{t("new.joinAddr")} <bdi dir="ltr">{q.trim()}</bdi></button>}
      {!address && rooms?.length === 0 && <p className="muted">{t("new.noPublic")}</p>}
      {!address && rooms?.map((r) => (
        <button key={r.room_id} className="user-row" disabled={busy} onClick={() => (joined(r.room_id) ? onDone(r.room_id, r.room_type === "m.space") : join(r.room_id, r.room_type === "m.space"))}>
          <Avatar mxc={r.avatar_url} name={r.name ?? r.canonical_alias ?? r.room_id} id={r.room_id} size={42} />
          <span>
            <b>{r.name ?? r.canonical_alias ?? r.room_id}</b>
            <small>{r.canonical_alias && <bdi dir="ltr">{r.canonical_alias}</bdi>} · {t("room.members", { count: r.num_joined_members })}</small>
          </span>
          <em>{joined(r.room_id) ? t("common.open") : t("invite.join")}</em>
        </button>
      ))}
    </div>
  );
}
