import { t } from "../i18n.ts";
import { useState } from "react";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { isCallStart } from "../hooks.ts";
import { fmtDuration, listTime } from "../logic.ts";
import { Icon } from "../icons.tsx";
import { callInfo, errText, me, RoomAvatar } from "./common.tsx";
import { alertDialog } from "./dialog.tsx";
import { start } from "./Call.tsx";

type Row = { ev: MatrixEvent; room: Room; out: boolean; video: boolean; missed: boolean; text: string };

const KIND = (video: boolean) => video ? t("calls.video") : t("calls.voice");
const CALL = (video: boolean) => video ? t("call.video") : t("call.voice");

/** Every 1:1 call in what's loaded of each chat, newest first. */
// ponytail: only what's in memory (recent history, plus whatever was scrolled back to); keep our own log if older calls matter
function callsIn(rooms: Room[]): Row[] {
  return rooms.flatMap((room) => room.getLiveTimeline().getEvents().filter(isCallStart).flatMap((ev): Row[] => {
    const i = callInfo(ev);
    if (!i || i.outcome.state === "ringing") return [];
    const out = ev.getSender() === me(), missed = i.outcome.state === "missed" || i.outcome.state === "declined";
    const what = out ? (missed ? t("calls.unanswered") : t("calls.outgoing")) : (i.outcome.state === "declined" ? t("calls.declined") : missed ? t("calls.missed") : t("calls.incoming"));
    const text = t("calls.row", { what, kind: KIND(i.video) }) + (i.outcome.duration ? ` · ${fmtDuration(i.outcome.duration)}` : "");
    return [{ ev, room, out, video: i.video, missed: missed && !out, text }];
  })).sort((x, y) => y.ev.getTs() - x.ev.getTs());
}

/** Tap opens the chat, the button calls back. */
export function CallsList({ rooms, onSelect }: { rooms: Room[]; onSelect: (roomId: string) => void }) {
  const [missedOnly, setMissedOnly] = useState(false);
  const rows = callsIn(rooms).filter((r) => !missedOnly || r.missed);
  return <>
    <nav className="folders calls-tabs" role="tablist">
      <button role="tab" aria-selected={!missedOnly} className={missedOnly ? "" : "on"} onClick={() => setMissedOnly(false)}>{t("folder.all")}</button>
      <button role="tab" aria-selected={missedOnly} className={missedOnly ? "on" : ""} onClick={() => setMissedOnly(true)}>{t("calls.missedTab")}</button>
    </nav>
    <div className="room-list scroll">
      {!rows.length ? <p className="empty-list">{missedOnly ? t("calls.noMissed") : t("calls.none")}</p> : rows.map((r) => (
        <div key={r.ev.getId()} className="call-row">
          <button className="room-item" onClick={() => onSelect(r.room.roomId)}>
            <RoomAvatar room={r.room} size={48} />
            <span className="room-item-body">
              <span className="room-item-top"><span className={"room-name" + (r.missed ? " call-missed" : "")}>{r.room.name}</span>
                <span className="room-time">{listTime(r.ev.getTs())}</span></span>
              <span className="room-item-bottom"><span className={"room-preview" + (r.missed ? " call-missed" : "")}>
                <span className="call-dir" aria-hidden>{r.out ? "↗" : "↙"}</span> {r.text}</span></span>
            </span>
          </button>
          <button className="icon-btn" onClick={() => start(r.room, r.video).catch((e) => alertDialog(errText(e)))}
            title={CALL(r.video)} aria-label={t("calls.callWith", { call: CALL(r.video), name: r.room.name })}><Icon name={r.video ? "video" : "phone"} /></button>
        </div>
      ))}
    </div>
  </>;
}
