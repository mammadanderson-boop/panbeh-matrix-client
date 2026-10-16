import { t } from "../i18n.ts";
import { useState } from "react";
import { ClientEvent, RoomStateEvent, type Room } from "matrix-js-sdk";
import { addToMyPack, canEditPacks, client, isPackGlobal, packsFor, personalPack, putPersonalPack, putRoomPack, roomPack, roomPacks, setPackGlobal, uploadEmote, type Pack } from "../matrix.ts";
import { useTick } from "../hooks.ts";
import { cleanCode, codeFrom, freeCode, num, PACK_CAP, packImages, TINT, type PackContent, type Tint, type Usage } from "../logic.ts";
import { Icon } from "../icons.tsx";
import { ContextMenu, errText, Select, Sheet, toast } from "./common.tsx";
import { alertDialog, confirmDialog, promptDialog } from "./dialog.tsx";
import { useSlider } from "./useSlider.ts";
import { EmoteImg } from "./Emoji.tsx";

const KIND: Record<Usage, string> = { emoticon: t("packs.emoji"), sticker: t("packs.sticker") };
const TICK = [ClientEvent.AccountData, RoomStateEvent.Events];
const TINTS: [Tint, string][] = [["auto", t("packs.tintAuto")], ["always", t("packs.tintAlways")], ["never", t("packs.tintNever")]];
/** `o` with its tint setting set, or dropped for "auto" (an image's "auto" = as its pack says). */
const withTint = <T extends { [TINT]?: Tint }>(o: T, t: Tint): T => { const { [TINT]: _, ...rest } = o; return (t === "auto" ? rest : { ...rest, [TINT]: t }) as T; };

/** A pack's images: add, rename, delete, or take one into mine. `use`: list only images usable that way and mark new ones so
 *  (my emoji and my stickers share the one personal pack); `mine`: it's that personal pack. */
function PackGrid({ load, save, use, editable, mine }: { load: () => PackContent; save: (c: PackContent) => Promise<unknown>; use?: Usage; editable: boolean; mine?: boolean }) {
  useTick(client, TICK);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; code: string } | null>(null);
  const c = load();
  const listOf = (c: PackContent) => use ? packImages(c, use) : Object.entries(c.images ?? {}).filter(([, i]) => i?.url?.startsWith("mxc://"));
  const list = listOf(c);
  const kind = use ?? (c.pack?.usage?.length === 1 ? c.pack.usage[0] : "emoticon"); // a room pack's own kind; mixed counts as emoji
  const full = list.length >= PACK_CAP[kind];
  const run = (fn: () => Promise<unknown>) => { setBusy(true); fn().catch((e) => alertDialog(errText(e))).finally(() => setBusy(false)); };

  /** Files that don't fit the pack or can't be used are skipped and listed; the rest still go in. */
  const add = (files: File[]) => run(async () => {
    const fits = files.slice(0, Math.max(0, PACK_CAP[kind] - list.length)), errors: string[] = [];
    if (fits.length < files.length) errors.push(t("packs.fullSkipped", { count: files.length - fits.length, max: PACK_CAP[kind] }));
    const up = [];
    for (const f of fits) {
      try { up.push({ name: f.name, img: await uploadEmote(f, kind) }); } catch (e) { errors.push(`${f.name}: ${errText(e)}`); }
    }
    if (up.length) {
      const cur = load(), images = { ...cur.images };
      for (const { name, img } of up) images[freeCode(codeFrom(name), images)] = { ...img, ...(use && { usage: [use] }) };
      await save({ ...cur, images });
    }
    if (errors.length) alertDialog(errors.join("\n"));
  });
  const rename = async (code: string) => {
    const next = await promptDialog(t("packs.shortcode"), { value: code, ok: t("common.save"), filter: (v) => cleanCode(v), hint: t("packs.shortcodeHint") });
    if (!next || next === code) return;
    const cur = load();
    if (Object.hasOwn(cur.images ?? {}, next)) return alertDialog(t("packs.exists", { code: next }));
    run(() => save({ ...cur, images: Object.fromEntries(Object.entries(cur.images ?? {}).map(([k, i]) => [k === code ? next : k, i])) }));
  };
  const without = (cur: PackContent, codes: string[]) => {
    const images = { ...cur.images }, other: Usage = use === "sticker" ? "emoticon" : "sticker";
    for (const code of codes) {
      const img = images[code];
      // in both of my collections (no usage of its own): only leave this one
      if (use && img && packImages({ pack: cur.pack, images: { [code]: img } }, other).length) images[code] = { ...img, usage: [other] };
      else delete images[code];
    }
    return { ...cur, images };
  };
  const remove = async (code: string) => {
    if (!await confirmDialog(t("packs.deleteQ", { code }), { ok: t("common.delete"), danger: true })) return;
    run(() => save(without(load(), [code])));
  };
  const removeAll = async () => {
    if (!await confirmDialog(t(mine ? (kind === "sticker" ? "packs.delAllMyStickers" : "packs.delAllMyEmoji") : (kind === "sticker" ? "packs.delAllRoomStickers" : "packs.delAllRoomEmoji"), { count: list.length }), { ok: t("packs.deleteAll"), danger: true })) return;
    run(async () => { const cur = load(); await save(without(cur, listOf(cur).map(([code]) => code))); });
  };
  const tintPack = (t: Tint) => run(() => { const cur = load(); return save({ ...cur, pack: withTint(cur.pack ?? {}, t) }); });
  const tintImage = (code: string, t: Tint) => run(() => {
    const cur = load();
    return cur.images?.[code] ? save({ ...cur, images: { ...cur.images, [code]: withTint(cur.images[code], t) } }) : Promise.resolve();
  });
  const tints = editable && kind !== "sticker"; // stickers keep their colors
  const take = (code: string) =>
    addToMyPack(code, c.images![code], kind).then(() => toast(kind === "sticker" ? t("packs.addedSticker") : t("packs.addedEmoji")), (e) => alertDialog(errText(e)));

  return (
    <>
      {tints && <>
        <label className="select-row">{t("packs.tint")}
          <Select value={c.pack?.[TINT] ?? "auto"} options={TINTS} disabled={busy} onChange={tintPack} />
        </label>
        <p className="muted">{t("packs.tintHint")}</p>
      </>}
      <div className="gif-grid pack-grid">
        {list.map(([code, i]) => (
          <button key={code} title={`:${code}:`} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, code })}>
            <EmoteImg url={i.url} alt="" className="" sticker={kind === "sticker"} /><small dir="ltr">:{code}:</small>
          </button>
        ))}
        {editable && !full && (
          <label className="pack-add" title={t("packs.addImage")} aria-label={t("packs.addImage")}>
            <input type="file" accept="image/*" multiple hidden disabled={busy}
              onChange={(e) => { const f = [...e.target.files!]; e.target.value = ""; if (f.length) add(f); }} />
            {busy ? <span className="spinner" /> : <Icon name="plus" />}
          </label>
        )}
      </div>
      {!list.length && !editable && <p className="muted">{t("packs.empty")}</p>}
      {editable && full && <p className="muted">{t("packs.full", { count: PACK_CAP[kind] })}</p>}
      {editable && list.length > 0 && (
        <div className="row-actions"><button className="warn" disabled={busy} onClick={() => void removeAll()}><Icon name="trash" /> {t("packs.deleteAll")}</button></div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} target=".pack-grid button" onClose={() => setMenu(null)}>
          {!mine && <button role="menuitem" onClick={() => { setMenu(null); take(menu.code); }}><Icon name="plus" /> {t("packs.addToMine")}</button>}
          {tints && ([["auto", t("packs.tintLikePack")], ...TINTS.slice(1)] as [Tint, string][]).map(([tn, label]) => {
            const on = (c.images?.[menu.code]?.[TINT] ?? "auto") === tn;
            return <button key={tn} role="menuitemradio" aria-checked={on} onClick={() => { setMenu(null); if (!on) tintImage(menu.code, tn); }}>
              <span className="menu-check">{on && <Icon name="check" />}</span> {t("packs.tintIs", { v: label })}</button>;
          })}
          {editable && <button role="menuitem" onClick={() => { setMenu(null); void rename(menu.code); }}><Icon name="edit" /> {t("common.rename")}</button>}
          {editable && <button role="menuitem" className="danger-item" onClick={() => { setMenu(null); void remove(menu.code); }}><Icon name="trash" /> {t("common.delete")}</button>}
        </ContextMenu>
      )}
    </>
  );
}

/** Settings: my emoji and my stickers, and the chats' packs I've turned on everywhere. */
export function MyPacks() {
  useTick(client, TICK);
  const [use, setUse] = useState<Usage>("emoticon");
  const pill = useSlider<HTMLDivElement>();
  const global = packsFor().filter((p) => p.roomId);
  return (
    <>
      <div className="segmented" data-pill ref={pill}>
        <button className={use === "emoticon" ? "on" : ""} onClick={() => setUse("emoticon")}>{t("packs.myEmoji")}</button>
        <button className={use === "sticker" ? "on" : ""} onClick={() => setUse("sticker")}>{t("packs.myStickers")}</button>
      </div>
      <PackGrid key={use} load={personalPack} save={putPersonalPack} use={use} editable mine />
      <p className="muted">{use === "sticker" ? t("packs.stickerHelp")
        : <>{t("packs.emojiHelpA")}<bdi>{t("packs.codeName")}</bdi>{t("packs.emojiHelpB")}</>}</p>
      {global.length > 0 && <h3>{t("packs.roomPacks")}</h3>}
      {global.map((p) => <GlobalSwitch key={p.key} pack={p} sub={client.getRoom(p.roomId!)?.name} />)}
    </>
  );
}

function GlobalSwitch({ pack, sub }: { pack: Pack; sub?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className="switch-row"><span>{sub ? pack.name : t("packs.global")}<small>{sub ?? t("packs.globalHint")}</small></span>
      <input type="checkbox" role="switch" disabled={busy} checked={isPackGlobal(pack)}
        onChange={(e) => { setBusy(true); setPackGlobal(pack, e.target.checked).catch((er) => alertDialog(errText(er))).finally(() => setBusy(false)); }} /></label>
  );
}

/** Room info: the chat's packs. Anyone can browse them, take images and turn them on everywhere; those allowed edit them. */
export function RoomPacks({ room }: { room: Room }) {
  useTick(client, TICK);
  const [open, setOpen] = useState<string | null>(null); // state key
  const packs = roomPacks(room), edit = canEditPacks(room);
  const load = (key: string) => () => room.currentState.getStateEvents("im.ponies.room_emotes", key)?.getContent<PackContent>() ?? {};
  const create = async (use: Usage) => {
    const name = await promptDialog(use === "sticker" ? t("packs.stickerPackName") : t("packs.emojiPackName"), { ok: t("packs.create"), value: room.name });
    if (name === null) return;
    const key = freeCode(use === "sticker" ? "stickers" : "emoji", Object.fromEntries(packs.map((p) => [p.stateKey, 1])));
    putRoomPack(room, key, { pack: { display_name: name || room.name, usage: [use] }, images: {} }).then(() => setOpen(key), (e) => alertDialog(errText(e)));
  };
  const rename = async (p: Pack) => {
    const name = await promptDialog(t("packs.name"), { ok: t("common.save"), value: p.name });
    if (name) putRoomPack(room, p.stateKey!, { ...p.content, pack: { ...p.content.pack, display_name: name } }).catch((e) => alertDialog(errText(e)));
  };
  const remove = async (p: Pack) => {
    if (await confirmDialog(t("packs.deletePackQ", { name: p.name }), { ok: t("common.delete"), danger: true }))
      putRoomPack(room, p.stateKey!, {}).then(() => setOpen(null), (e) => alertDialog(errText(e)));
  };
  const cur = open === null ? null : roomPack(room, open, load(open)());
  return (
    <>
      {packs.length === 0 && <p className="muted">{t("packs.none")}</p>}
      {packs.map((p) => {
        const first = Object.values(p.content.images ?? {})[0]?.url;
        const kinds = p.content.pack?.usage?.length === 1 ? KIND[p.content.pack.usage[0]] : t("packs.both");
        return (
          <button key={p.key} className="user-row" onClick={() => setOpen(p.stateKey!)}>
            <span className="device-box">{p.avatar ?? first ? <EmoteImg url={(p.avatar ?? first)!} alt="" className="" sticker={kinds === KIND.sticker} /> : <Icon name="smile" />}</span>
            <span><b>{p.name}</b><small>{kinds} · {t("packs.images", { count: Object.keys(p.content.images ?? {}).length })}</small></span>
          </button>
        );
      })}
      {edit && <>
        <button className="user-row" onClick={() => void create("emoticon")}><span className="device-box"><Icon name="plus" /></span><span><b>{t("packs.newEmoji")}</b></span></button>
        <button className="user-row" onClick={() => void create("sticker")}><span className="device-box"><Icon name="plus" /></span><span><b>{t("packs.newSticker")}</b></span></button>
      </>}
      {cur && (
        <Sheet title={cur.name} onClose={() => setOpen(null)}>
          <GlobalSwitch pack={cur} />
          <PackGrid load={load(open!)} save={(c) => putRoomPack(room, open!, c)} editable={edit} />
          {edit && <>
            <button className="user-row" onClick={() => void rename(cur)}><span className="device-box"><Icon name="edit" /></span><span><b>{t("packs.rename")}</b></span></button>
            <button className="danger" onClick={() => void remove(cur)}>{t("packs.delete")}</button>
          </>}
        </Sheet>
      )}
    </>
  );
}
