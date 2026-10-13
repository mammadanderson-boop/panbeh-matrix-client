import { useState } from "react";
import { ClientEvent, RoomStateEvent, type Room } from "matrix-js-sdk";
import { addToMyPack, canEditPacks, client, isPackGlobal, packsFor, personalPack, putPersonalPack, putRoomPack, roomPack, roomPacks, setPackGlobal, uploadEmote, type Pack } from "../matrix.ts";
import { useTick } from "../hooks.ts";
import { codeFrom, freeCode, num, packImages, type PackContent, type Usage } from "../logic.ts";
import { Icon } from "../icons.tsx";
import { ContextMenu, errText, Sheet, toast } from "./common.tsx";
import { alertDialog, confirmDialog, promptDialog } from "./dialog.tsx";
import { useSlider } from "./useSlider.ts";
import { EmoteImg } from "./Emoji.tsx";

const KIND: Record<Usage, string> = { emoticon: "اموجی", sticker: "استیکر" };
const TICK = [ClientEvent.AccountData, RoomStateEvent.Events];

/** A pack's images: add, rename, delete, or take one into mine. `use`: list only images usable that way and mark new ones so
 *  (my emoji and my stickers share the one personal pack); `mine`: it's that personal pack. */
function PackGrid({ load, save, use, editable, mine }: { load: () => PackContent; save: (c: PackContent) => Promise<unknown>; use?: Usage; editable: boolean; mine?: boolean }) {
  useTick(client, TICK);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; code: string } | null>(null);
  const c = load();
  const list = use ? packImages(c, use) : Object.entries(c.images ?? {}).filter(([, i]) => i?.url?.startsWith("mxc://"));
  const run = (fn: () => Promise<unknown>) => { setBusy(true); fn().catch((e) => alertDialog(errText(e))).finally(() => setBusy(false)); };

  const add = (files: File[]) => run(async () => {
    const up = [];
    for (const f of files) up.push({ name: f.name, img: await uploadEmote(f) });
    const cur = load(), images = { ...cur.images };
    for (const { name, img } of up) images[freeCode(codeFrom(name), images)] = { ...img, ...(use && { usage: [use] }) };
    await save({ ...cur, images });
  });
  const rename = async (code: string) => {
    const next = (await promptDialog("نام کوتاه (بدون فاصله)", { value: code, ok: "ذخیره" }))?.replace(/[\s:]+/g, "_").slice(0, 32);
    if (!next || next === code) return;
    const cur = load();
    if (Object.hasOwn(cur.images ?? {}, next)) return alertDialog(`«:${next}:» در این بسته هست`);
    run(() => save({ ...cur, images: Object.fromEntries(Object.entries(cur.images ?? {}).map(([k, i]) => [k === code ? next : k, i])) }));
  };
  const remove = async (code: string) => {
    if (!await confirmDialog(`«:${code}:» حذف شود؟`, { ok: "حذف", danger: true })) return;
    const cur = load(), images = { ...cur.images }, img = images[code];
    const other: Usage = use === "sticker" ? "emoticon" : "sticker";
    // in both of my collections (no usage of its own): only leave this one
    if (use && img && packImages({ pack: cur.pack, images: { [code]: img } }, other).length) images[code] = { ...img, usage: [other] };
    else delete images[code];
    run(() => save({ ...cur, images }));
  };
  const take = (code: string) => {
    const as = use ?? (c.pack?.usage?.length === 1 ? c.pack.usage[0] : "emoticon");
    addToMyPack(code, c.images![code], as).then(() => toast(`به ${KIND[as]}های شما اضافه شد`), (e) => alertDialog(errText(e)));
  };

  return (
    <>
      <div className="gif-grid pack-grid">
        {list.map(([code, i]) => (
          <button key={code} title={`:${code}:`} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, code })}>
            <EmoteImg url={i.url} alt="" className="" /><small dir="ltr">:{code}:</small>
          </button>
        ))}
        {editable && (
          <label className="pack-add" title="افزودن تصویر" aria-label="افزودن تصویر">
            <input type="file" accept="image/*" multiple hidden disabled={busy}
              onChange={(e) => { const f = [...e.target.files!]; e.target.value = ""; if (f.length) add(f); }} />
            {busy ? <span className="spinner" /> : <Icon name="plus" />}
          </label>
        )}
      </div>
      {!list.length && !editable && <p className="muted">خالی است</p>}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} target=".pack-grid button" onClose={() => setMenu(null)}>
          {!mine && <button role="menuitem" onClick={() => { setMenu(null); take(menu.code); }}><Icon name="plus" /> افزودن به مال من</button>}
          {editable && <button role="menuitem" onClick={() => { setMenu(null); void rename(menu.code); }}><Icon name="edit" /> تغییر نام</button>}
          {editable && <button role="menuitem" className="danger-item" onClick={() => { setMenu(null); void remove(menu.code); }}><Icon name="trash" /> حذف</button>}
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
        <button className={use === "emoticon" ? "on" : ""} onClick={() => setUse("emoticon")}>اموجی‌های من</button>
        <button className={use === "sticker" ? "on" : ""} onClick={() => setUse("sticker")}>استیکرهای من</button>
      </div>
      <PackGrid key={use} load={personalPack} save={putPersonalPack} use={use} editable mine />
      <p className="muted">{use === "sticker" ? "استیکرها در پنل اموجی، زبانه‌ی استیکر هستند."
        : <>اموجی‌ها در همه‌ی گفتگوها کار می‌کنند: از پنل اموجی بزنید یا <bdi>:نام:</bdi> را بنویسید. اموجی دیگران را با زدن روی آن در پیام، و استیکرشان را از منوی پیام، به مال خودتان اضافه کنید.</>}</p>
      {global.length > 0 && <h3>بسته‌های گفتگوها</h3>}
      {global.map((p) => <GlobalSwitch key={p.key} pack={p} sub={client.getRoom(p.roomId!)?.name} />)}
    </>
  );
}

function GlobalSwitch({ pack, sub }: { pack: Pack; sub?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className="switch-row"><span>{sub ? pack.name : "استفاده در همه‌ی گفتگوها"}<small>{sub ?? "نه فقط در همین گفتگو"}</small></span>
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
    const name = await promptDialog(`نام بسته‌ی ${KIND[use]}`, { ok: "ساختن", value: room.name });
    if (name === null) return;
    const key = freeCode(use === "sticker" ? "stickers" : "emoji", Object.fromEntries(packs.map((p) => [p.stateKey, 1])));
    putRoomPack(room, key, { pack: { display_name: name || room.name, usage: [use] }, images: {} }).then(() => setOpen(key), (e) => alertDialog(errText(e)));
  };
  const rename = async (p: Pack) => {
    const name = await promptDialog("نام بسته", { ok: "ذخیره", value: p.name });
    if (name) putRoomPack(room, p.stateKey!, { ...p.content, pack: { ...p.content.pack, display_name: name } }).catch((e) => alertDialog(errText(e)));
  };
  const remove = async (p: Pack) => {
    if (await confirmDialog(`بسته‌ی «${p.name}» برای همه‌ی اعضا حذف شود؟`, { ok: "حذف", danger: true }))
      putRoomPack(room, p.stateKey!, {}).then(() => setOpen(null), (e) => alertDialog(errText(e)));
  };
  const cur = open === null ? null : roomPack(room, open, load(open)());
  return (
    <>
      {packs.length === 0 && <p className="muted">این گفتگو بسته‌ی اموجی یا استیکر ندارد.</p>}
      {packs.map((p) => {
        const first = Object.values(p.content.images ?? {})[0]?.url;
        const kinds = p.content.pack?.usage?.length === 1 ? KIND[p.content.pack.usage[0]] : "اموجی و استیکر";
        return (
          <button key={p.key} className="user-row" onClick={() => setOpen(p.stateKey!)}>
            <span className="device-box">{p.avatar ?? first ? <EmoteImg url={(p.avatar ?? first)!} alt="" className="" /> : <Icon name="smile" />}</span>
            <span><b>{p.name}</b><small>{kinds} · {num(Object.keys(p.content.images ?? {}).length)} تصویر</small></span>
          </button>
        );
      })}
      {edit && <>
        <button className="user-row" onClick={() => void create("emoticon")}><span className="device-box"><Icon name="plus" /></span><span><b>بسته‌ی اموجی جدید</b></span></button>
        <button className="user-row" onClick={() => void create("sticker")}><span className="device-box"><Icon name="plus" /></span><span><b>بسته‌ی استیکر جدید</b></span></button>
      </>}
      {cur && (
        <Sheet title={cur.name} onClose={() => setOpen(null)}>
          <GlobalSwitch pack={cur} />
          <PackGrid load={load(open!)} save={(c) => putRoomPack(room, open!, c)} editable={edit} />
          {edit && <>
            <button className="user-row" onClick={() => void rename(cur)}><span className="device-box"><Icon name="edit" /></span><span><b>تغییر نام بسته</b></span></button>
            <button className="danger" onClick={() => void remove(cur)}>حذف بسته</button>
          </>}
        </Sheet>
      )}
    </>
  );
}
