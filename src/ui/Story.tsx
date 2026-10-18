// Stories UI: a WhatsApp-style lane above the chat list, a fullscreen viewer (taps, 6s timer, progress bars) and a
// posting sheet. Portal-based: the lane lives in the Sidebar but its screens cover the whole app.
import { rtl, t } from "../i18n.ts";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ClientEvent, RoomEvent, RoomStateEvent, type MatrixEvent, type Room } from "matrix-js-sdk";
import { client, mediaUrl } from "../matrix.ts";
import { usePromise, useTick } from "../hooks.ts";
import { errText, RoomAvatar, senderName, Sheet, toast } from "./common.tsx";
import { alertDialog } from "./dialog.tsx";
import { hasUnseen, markStorySeen, sendStory, storiesOf, storyLanes } from "../stories.ts";
import { Icon } from "../icons.tsx";
import { stamp } from "../logic.ts";

const SHOW_MS = 6_000;

export function StoriesLane() {
  useTick(client, [RoomEvent.Timeline, RoomEvent.Receipt, RoomStateEvent.Events, ClientEvent.AccountData]);
  const rooms = storyLanes();
  const [view, setView] = useState<{ rooms: Room[]; start: number } | null>(null);
  const [composing, setComposing] = useState(false);
  const mine = rooms.find((r) => !!r.getAccountData("ir.panbeh.story.mine" as never));
  return (
    <div className="story-lane">
      <button className="story-cell" onClick={() => (mine ? setView({ rooms, start: rooms.indexOf(mine) }) : setComposing(true))}>
        <span className={"story-ring" + (mine && mine.getMyMembership() === "join" && !hasUnseen(mine) ? " seen" : "")}>
          {mine ? <RoomAvatar room={mine} size={52} /> : <span className="story-add"><Icon name="plus" size={22} /></span>}
        </span>
        <small>{mine ? t("story.new") : t("story.title")}</small>
      </button>
      {rooms.map((r, i) => r !== mine && (
        <button key={r.roomId} className="story-cell" onClick={() => setView({ rooms, start: i })}>
          <span className={"story-ring" + (hasUnseen(r) ? "" : " seen")}><RoomAvatar room={r} size={52} /></span>
          <small dir="auto">{r.name || senderName(r.getLiveTimeline().getEvents().at(-1)!) || t("story.title")}</small>
        </button>
      ))}
      {view && createPortal(<StoryViewer rooms={view.rooms} start={view.start} onClose={() => setView(null)} />, document.body)}
      {composing && createPortal(<StoryComposer onClose={() => setComposing(false)} />, document.body)}
    </div>
  );
}

export function StoryComposer({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : undefined), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    try {
      await sendStory(file, caption.trim());
      toast(t("story.sent"));
      onClose();
    } catch (err) {
      alertDialog(errText(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={t("story.add")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="story-pick">
          {preview
            ? file?.type.startsWith("video/") ? <video src={preview} muted playsInline /> : <img src={preview} alt="" />
            : <><Icon name="image" size={28} /> <span>{t("story.pickHint")}</span></>}
          <input type="file" accept="image/*,video/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t("story.caption")} aria-label={t("story.caption")} dir="auto" />
        <button className="primary" disabled={busy || !file}>{busy ? t("common.sending") : t("story.send")}</button>
      </form>
    </Sheet>
  );
}

/** Fullscreen viewer: opens on room `start`, runs to the end of the last room that still has live stories. */
export function StoryViewer({ rooms, start = 0, onClose }: { rooms: Room[]; start?: number; onClose: () => void }) {
  const [ri, setRi] = useState(start);
  const room = rooms[ri];
  const list = useMemo(() => (room ? storiesOf(room) : []), [room]);
  const [si, setSi] = useState(0);

  const step = (dir: 1 | -1) => {
    if (dir === -1 && si > 0) return setSi(si - 1);
    if (dir === -1) { // before a room's first story: the last story of the room before it
      for (let i = ri - 1; i >= 0; i--) { const prev = storiesOf(rooms[i]); if (prev.length) { setRi(i); setSi(prev.length - 1); return; } }
      return;
    }
    setSi(si + 1); // the walk effect turns running past the end into room change or close
  };

  const ev: MatrixEvent | undefined = list[Math.min(si, list.length - 1)];
  useEffect(() => { // progress + seen marking + walking rooms; the story already gone (si past the list) means next room
    if (!list.length) return onClose();
    const at = Math.min(si, list.length - 1);
    markStorySeen(list[at]);
    if (si >= list.length) {
      const nxt = rooms.findIndex((r, i) => i > ri && storiesOf(r).length);
      if (nxt === -1) return onClose();
      setRi(nxt);
      setSi(0);
    } else {
      const timer = setTimeout(() => setSi((s) => s + 1), SHOW_MS);
      return () => clearTimeout(timer);
    }
  }, [ri, si, list]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") step(rtl ? 1 : -1);
      else if (e.key === "ArrowRight") step(rtl ? -1 : 1);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  const url = usePromise(useMemo(() => (ev ? mediaUrl(ev.getContent()) : null), [ev]));
  if (!ev || !room) return null;
  const content = ev.getContent();
  return (
    <div className="story-backdrop" role="dialog" aria-label={t("story.title")}>
      <div className="story-prog">
        {list.map((s, i) => <i key={s.getId()} className={i < Math.min(si, list.length - 1) ? "done" : i === si ? "cur" : ""} />)}
      </div>
      <div className="story-meta">
        <RoomAvatar room={room} size={38} />
        <div className="story-who">
          <b dir="auto">{room.name || senderName(ev)}</b>
          <small>{stamp(ev.getTs())}</small>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}><Icon name="close" size={20} /></button>
      </div>
      <div className="story-media">
        {url
          ? content.msgtype === "m.video" ? <video key={ev.getId()} src={url} autoPlay onEnded={() => step(1)} playsInline /> : <img key={ev.getId()} src={url} alt="" />
          : <span className="spinner inline" />}
        <div className="story-tap" onClick={(e) => step((e.clientX / innerWidth > (rtl ? 0.3 : 0.7) ? 1 : -1) as 1 | -1)} aria-hidden><b /><b /></div>
      </div>
      {typeof content.body === "string" && content.body && <p className="story-caption" dir="auto">{content.body}</p>}
    </div>
  );
}