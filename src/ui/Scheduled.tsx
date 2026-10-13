import { useEffect, useState } from "react";
import { MatrixEvent, type Room } from "matrix-js-sdk";
import { cancelScheduled, canSchedule, onScheduledChange, scheduledIn, scheduleMessage, sendScheduledNow, type Scheduled } from "../matrix.ts";
import { usePromise } from "../hooks.ts";
import { formatMessage, num, scheduleDays, scheduleLabel } from "../logic.ts";
import { Icon } from "../icons.tsx";
import { errText, me, previewText, Select, Sheet } from "./common.tsx";
import { alertDialog, confirmDialog } from "./dialog.tsx";

const HOURS: [number, string][] = Array.from({ length: 24 }, (_, h) => [h, num(h).padStart(2, "۰")]);
const MINUTES: [number, string][] = Array.from({ length: 12 }, (_, i) => [i * 5, num(i * 5).padStart(2, "۰")]);
const STEP = 5 * 60_000;

/** A Jalali day, hour and minute (5-minute steps) for a message to go out; starts an hour ahead unless `initial` is given. */
export function SchedulePicker({ initial, onPick, onClose }: { initial?: number; onPick: (ts: number) => void; onClose: () => void }) {
  const [days] = useState(() => scheduleDays());
  const start = new Date(initial ?? Math.ceil((Date.now() + 3_600_000) / STEP) * STEP);
  const [day, setDay] = useState(() => days.findLast((d) => d.ts <= start.getTime())?.ts ?? days[0].ts);
  const [hour, setHour] = useState(start.getHours());
  const [minute, setMinute] = useState(start.getMinutes() - (start.getMinutes() % 5));
  const at = new Date(day).setHours(hour, minute);
  const past = at < Date.now() + 60_000;
  return (
    <Sheet title="ارسال زمان‌بندی‌شده" onClose={onClose}>
      <label className="select-row">روز
        <Select value={day} options={days.map((d) => [d.ts, d.label] as [number, string])} onChange={setDay} /></label>
      <label className="select-row">ساعت
        <span className="time-pick" dir="ltr">
          <Select value={hour} options={HOURS} onChange={setHour} />:<Select value={minute} options={MINUTES} onChange={setMinute} />
        </span>
      </label>
      {past && <p className="error">این زمان گذشته است</p>}
      <button className="primary" disabled={past} onClick={() => onPick(at)}>ارسال در {scheduleLabel(at)}</button>
    </Sheet>
  );
}

/** The room's scheduled messages, kept fresh: re-read when ours change and when the next one is due to go out. */
export function useScheduled(room: Room) {
  const ok = usePromise(canSchedule());
  const [list, setList] = useState<Scheduled[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => onScheduledChange(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    if (!ok) return;
    let live = true;
    scheduledIn(room.roomId).then((l) => { if (live) setList(l); }, () => {});
    return () => { live = false; };
  }, [ok, room.roomId, tick]);
  useEffect(() => { // once the next one has gone out, it leaves the list
    const next = list[0]?.sendAt;
    if (!next) return;
    const t = setTimeout(() => setTick((x) => x + 1), Math.min(2 ** 31 - 1, Math.max(0, next - Date.now()) + 3000));
    return () => clearTimeout(t);
  }, [list]);
  return { ok: !!ok, list };
}

const preview = (s: Scheduled) =>
  s.content ? previewText(new MatrixEvent({ type: s.type, content: s.content, sender: me(), room_id: s.roomId })) : "پیام رمزنگاری‌شده از دستگاهی دیگر";

/** Scheduled messages of a chat: send now, change (text and time), delete. */
export function ScheduledList({ room, list, onClose }: { room: Room; list: Scheduled[]; onClose: () => void }) {
  const [editing, setEditing] = useState<Scheduled | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>) => { setBusy(true); fn().catch((e) => alertDialog(errText(e))).finally(() => setBusy(false)); };
  useEffect(() => { if (!list.length && !editing) onClose(); }, [list.length]);
  if (editing) return <EditScheduled room={room} s={editing} onDone={() => setEditing(null)} />;
  return (
    <Sheet title={`پیام‌های زمان‌بندی‌شده (${num(list.length)})`} onClose={onClose}>
      {list.map((s) => (
        <div key={s.id} className="user-row scheduled-row">
          <span className="device-box"><Icon name="clock" /></span>
          <span><b dir="auto">{preview(s)}</b><small>{scheduleLabel(s.sendAt)}</small></span>
          <span className="scheduled-actions">
            <button className="row-btn" disabled={busy} onClick={() => act(() => sendScheduledNow(s.id))}>ارسال اکنون</button>
            {s.content && <button className="icon-btn" disabled={busy} title="تغییر" aria-label="تغییر" onClick={() => setEditing(s)}><Icon name="edit" size={18} /></button>}
            <button className="icon-btn" disabled={busy} title="حذف" aria-label="حذف"
              onClick={() => confirmDialog("این پیام زمان‌بندی‌شده حذف شود؟", { danger: true }).then((y) => y && act(() => cancelScheduled(s.id)))}><Icon name="trash" size={18} /></button>
          </span>
        </div>
      ))}
    </Sheet>
  );
}

/** Change a scheduled message: the text (text messages) and the time. The new one is scheduled before the old one goes. */
function EditScheduled({ room, s, onDone }: { room: Room; s: Scheduled; onDone: () => void }) {
  const c = s.content!;
  const text = c.msgtype === "m.text" || c.msgtype === "m.emote" || c.msgtype === "m.notice";
  const [body, setBody] = useState(String(c.body ?? ""));
  const [picking, setPicking] = useState(!text);
  const [busy, setBusy] = useState(false);
  const save = async (sendAt: number) => {
    setBusy(true);
    try {
      let next = c;
      if (text && body.trim() !== c.body) {
        const html = formatMessage(body.trim(), []);
        next = { ...c, body: body.trim(), format: undefined, formatted_body: undefined, ...(html && { format: "org.matrix.custom.html", formatted_body: html.html }) };
        next = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
      }
      await scheduleMessage(room, next, sendAt, s.type);
      await cancelScheduled(s.id);
      onDone();
    } catch (e) { alertDialog(errText(e)); }
    setBusy(false);
  };
  if (picking) return <SchedulePicker initial={s.sendAt} onPick={(ts) => void save(ts)} onClose={text ? () => setPicking(false) : onDone} />;
  return (
    <Sheet title="تغییر پیام زمان‌بندی‌شده" onClose={onDone}>
      <textarea className="send-caption" rows={4} dir="auto" value={body} onChange={(e) => setBody(e.target.value)} aria-label="متن پیام" />
      <p className="muted">{scheduleLabel(s.sendAt)}</p>
      <button disabled={busy} onClick={() => setPicking(true)}><Icon name="clock" size={18} /> تغییر زمان</button>
      <button className="primary" disabled={busy || !body.trim()} onClick={() => void save(s.sendAt)}>ذخیره</button>
    </Sheet>
  );
}
