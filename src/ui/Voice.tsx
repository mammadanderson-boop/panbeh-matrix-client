import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type MutableRefObject, type ReactNode } from "react";
import type { MatrixEvent } from "matrix-js-sdk";
import { downsample, fmtDuration, num } from "../logic.ts";
import { Icon } from "../icons.tsx";
import { audioDuration, errText, isVoice, senderName } from "./common.tsx";
import { client, mediaUrl } from "../matrix.ts";
import { eventsAround } from "../hooks.ts";
import { alertDialog } from "./dialog.tsx";
import { AUDIO_BPS } from "../call.ts";
import { loadPrefs } from "./Settings.tsx";

const BARS = 40;
const SPEEDS = [1, 1.5, 2, 0.5];
// global like Telegram: the speed you picked last applies to every voice message
let speed = SPEEDS.includes(Number(localStorage.getItem("panbeh.voiceSpeed"))) ? Number(localStorage.getItem("panbeh.voiceSpeed")) : 1;

export type Track = { id: string; ev?: MatrixEvent; title?: string; load: () => Promise<string> | null; duration: number; waveform?: unknown };
type Snap = { track: Track | null; state: "idle" | "loading" | "playing" | "paused"; pos: number; dur: number };

/** One <audio> for the whole app, so playback survives scrolling and chat switches. */
const audio = new Audio();
audio.preload = "none";
let snap: Snap = { track: null, state: "idle", pos: 0, dur: 0 };
const subs = new Set<() => void>();
const set = (p: Partial<Snap>) => { snap = { ...snap, ...p }; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const usePlayer = () => useSyncExternalStore(subscribe, () => snap);

export function trackFor(ev: MatrixEvent): Track {
  const c = ev.getContent();
  return {
    id: ev.getId()!, ev, title: isVoice(c) ? undefined : c.body,
    load: () => mediaUrl(c as Parameters<typeof mediaUrl>[0]), duration: audioDuration(c),
    waveform: c["org.matrix.msc1767.audio"]?.waveform ?? c["m.audio_details"]?.waveform,
  };
}

export function stopPlayer() {
  audio.pause();
  set({ track: null, state: "idle", pos: 0, dur: 0 });
}

async function start(t: Track) {
  set({ track: t, state: "loading", pos: 0, dur: t.duration / 1000 });
  audio.pause(); // the previous one stops while this one loads
  try {
    const url = await t.load();
    if (!url) throw new Error("فایل صوتی در دسترس نیست");
    if (snap.track !== t) return; // user picked something else meanwhile
    audio.src = url;
    audio.playbackRate = speed;
    await audio.play();
  } catch (e) {
    if (snap.track === t) set({ state: "idle" });
    alertDialog(errText(e));
  }
}

function playNext(ev: MatrixEvent) {
  const room = client.getRoom(ev.getRoomId());
  const evs = room ? eventsAround(room, ev) : [];
  const next = evs.slice(evs.findIndex((e) => e.getId() === ev.getId()) + 1).find((e) => e.getContent().msgtype === "m.audio" && !e.isRedacted());
  if (evs.some((e) => e.getId() === ev.getId()) && next) return void start(trackFor(next));
  stopPlayer(); // the last one: the bar above the chat closes
}

audio.onplay = () => set({ state: "playing" });
audio.onpause = () => snap.state !== "loading" && set({ state: "paused" });
audio.ontimeupdate = () => set({ pos: audio.currentTime });
audio.onloadedmetadata = () => Number.isFinite(audio.duration) && set({ dur: audio.duration }); // recorder webm reports Infinity
audio.onended = () => (snap.track?.ev ? playNext(snap.track.ev) : set({ pos: 0, state: "paused" }));

function toggle(t: Track) {
  if (snap.track?.id !== t.id) return void start(t);
  if (snap.state === "playing") audio.pause();
  else if (snap.state === "paused") audio.play().catch((e) => alertDialog(errText(e)));
}

function cycleSpeed() {
  speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
  localStorage.setItem("panbeh.voiceSpeed", String(speed));
  audio.playbackRate = speed;
  set({});
}

/** Voice/audio player. The media is fetched on first play, so a chat full of voice notes downloads nothing up front.
 *  `lead` replaces the play button (an upload's progress ring). */
export function AudioPlayer({ track, lead }: { track: Track; lead?: ReactNode }) {
  const s = usePlayer();
  const cur = s.track?.id === track.id;
  const state = cur ? s.state : "idle", pos = cur ? s.pos : 0, dur = cur ? s.dur : track.duration / 1000;
  const wave = Array.isArray(track.waveform) ? track.waveform.filter((n): n is number => typeof n === "number") : [];
  const bars = wave.length ? downsample(wave, BARS) : Array<number>(BARS).fill(320);
  const progress = dur ? pos / dur : 0;

  function seekTo(f: number) {
    if (!cur || !dur || state === "loading") return toggle(track);
    audio.currentTime = Math.min(Math.max(f, 0), 1) * dur;
    set({ pos: audio.currentTime });
  }

  const onWave = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - r.left) / r.width);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); seekTo((pos + (e.key === "ArrowRight" ? 5 : -5)) / dur); }
  };

  return (
    <div className="voice" dir="ltr">
      {lead ?? (
        <button className="voice-play" onClick={() => toggle(track)} aria-label={state === "playing" ? "توقف" : "پخش"}>
          {state === "loading" ? <span className="spinner inline" /> : <Icon name={state === "playing" ? "pause" : "play"} size={22} />}
        </button>
      )}
      <div className="voice-body">
        {track.title && <b className="voice-title" dir="auto">{track.title}</b>}
        <div className="wave" onClick={onWave} onKeyDown={onKey} tabIndex={0} role="slider" aria-label="موقعیت پخش"
          aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(pos)}>
          {bars.map((h, i) => <span key={i} className={i / BARS < progress ? "on" : ""} style={{ height: `${15 + (h / 1024) * 85}%` }} />)}
        </div>
        <div className="voice-meta">
          <span>{fmtDuration((state === "idle" ? dur : pos) * 1000)}</span>
          <button className="speed" onClick={cycleSpeed} aria-label="سرعت پخش">{num(speed)}×</button>
        </div>
      </div>
    </div>
  );
}

/** Bar pinned above the chat while something plays; click the text to jump to the message. */
export function NowPlaying({ onJump }: { onJump?: (id: string) => void }) {
  const { track, state, pos, dur } = usePlayer();
  const ev = track?.ev;
  if (!track || !ev) return null;
  const go = () => (ev.getRoomId() === location.hash.slice(1) && onJump ? onJump(ev.getId()!) : void (location.hash = ev.getRoomId()!));
  return (
    <div className="now-playing">
      <button className="icon-btn" onClick={() => toggle(track)} aria-label={state === "playing" ? "توقف" : "پخش"}>
        {state === "loading" ? <span className="spinner inline" /> : <Icon name={state === "playing" ? "pause" : "play"} size={22} />}
      </button>
      <button className="now-playing-text" onClick={go}>
        <b>{senderName(ev)}</b>
        <span>{track.title ?? "پیام صوتی"}</span>
      </button>
      <span className="now-playing-time">{fmtDuration(pos * 1000)}</span>
      <button className="speed" onClick={cycleSpeed} aria-label="سرعت پخش">{num(speed)}×</button>
      <button className="icon-btn" onClick={stopPlayer} aria-label="بستن"><Icon name="close" /></button>
      <i className="now-playing-line" style={{ width: dur ? `${Math.min(100, (pos / dur) * 100)}%` : 0 }} />
    </div>
  );
}

export type Voice = { file: File; extra: Record<string, unknown> };
type Recording = { blob: Blob; url: string; duration: number; waveform: number[] };
/** The mic button drives a recording while the finger is down: finish(true) on release sends, finish(false) cancels. */
export type RecControl = { finish: (send: boolean) => void };
/** locked: started by a tap, or the finger slid up; the recorder's own stop / send / trash buttons then take over.
 *  dx: how far the held finger has slid toward cancelling (≤ 0). */
type RecProps = { onDone: (v?: Voice) => void; locked: boolean; dx: number; control: MutableRefObject<RecControl | null> };
const MIN_MS = 700; // a release sooner than this was a slip, not a message

const voiceOf = (r: { blob: Blob; duration: number; waveform: number[] }): Voice => {
  const type = r.blob.type || "audio/webm";
  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
  const duration = Math.round(r.duration);
  return {
    file: new File([r.blob], `voice.${ext}`, { type }),
    extra: {
      msgtype: "m.audio", body: "پیام صوتی", info: { duration },
      // what Element reads to show it as a voice message with a waveform
      "org.matrix.msc1767.audio": { duration, waveform: r.waveform },
      "org.matrix.msc3245.voice": {},
    },
  };
};

/** While the finger is down: the time, "slide to cancel" following the finger, and the lock above the button. */
function HeldRow({ elapsed, dx, icon }: { elapsed: number; dx: number; icon: "mic" | "camera" }) {
  return (
    <div className="composer-row recorder held">
      <div className="recorder-live" dir="ltr">
        <span className="rec-dot" />
        <span className="rec-time">{fmtDuration(elapsed)}</span>
        <span className="rec-hint" dir="rtl" style={{ transform: `translateX(${dx}px)`, opacity: Math.max(0, 1 + dx / 120) }}><Icon name="back" size={16} /> برای لغو بکشید</span>
      </div>
      <span className="rec-mic"><Icon name={icon} /><span className="rec-lock" aria-hidden><Icon name="lock" size={16} /></span></span>
    </div>
  );
}

/** Records on mount. Held: release sends (control.finish). Locked: ■ stops into a preview, ✓ sends, trash discards.
 *  onDone() without a voice = cancelled. */
export function VoiceRecorder({ onDone, locked, dx, control }: RecProps) {
  const [rec, setRec] = useState<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const levels = useRef<number[]>([]);
  const stop = useRef<(keep: boolean) => void>(() => {});
  const sendOnStop = useRef(false);

  useEffect(() => {
    let live = true, keep = false, timer = 0, url = "";
    let stream: MediaStream | undefined, ctx: AudioContext | undefined, r: MediaRecorder | undefined;
    const release = () => { clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); ctx?.close().catch(() => {}); };
    stop.current = (k) => {
      keep = k;
      if (r?.state === "recording") r.stop();
      else if (sendOnStop.current) onDone(); // released before the mic even opened
      release();
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 } }) // nothing plays while recording;
      } catch {
        alertDialog(window.isSecureContext
          ? "دسترسی به میکروفون ممکن نشد. اجازه‌ی میکروفون را در تنظیمات مرورگر یا برنامه بدهید."
          : "دسترسی به میکروفون ممکن نشد. ضبط صدا فقط روی https یا localhost کار می‌کند.");
        return onDone();
      }
      if (!live) return release();
      const type = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t));
      r = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: AUDIO_BPS[loadPrefs().audioQuality] });
      const chunks: Blob[] = [];
      const started = Date.now();
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        if (!keep || !live) return;
        const got = { blob: new Blob(chunks, { type: r!.mimeType.split(";")[0] }), duration: Date.now() - started, waveform: downsample(levels.current) };
        if (sendOnStop.current) return onDone(got.duration < MIN_MS ? undefined : voiceOf(got));
        url = URL.createObjectURL(got.blob);
        setRec({ ...got, url });
      };
      ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      timer = window.setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        levels.current.push(Math.sqrt(sum / buf.length));
        setElapsed(Date.now() - started);
      }, 100);
      r.start();
    })();
    return () => { live = false; stop.current(false); if (snap.track?.id === "preview:" + url) stopPlayer(); if (url) URL.revokeObjectURL(url); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  control.current = { finish: (send) => { if (send) { sendOnStop.current = true; stop.current(true); } else { stop.current(false); onDone(); } } };

  if (!locked && !rec) return <HeldRow elapsed={elapsed} dx={dx} icon="mic" />;
  const recent = levels.current.slice(-BARS);
  return (
    <div className="composer-row recorder">
      <button className="icon-btn" onClick={() => onDone()} title="حذف" aria-label="حذف"><Icon name="trash" /></button>
      {rec ? (
        <div className="recorder-preview"><AudioPlayer track={{ id: "preview:" + rec.url, load: () => Promise.resolve(rec.url), duration: rec.duration, waveform: rec.waveform }} /></div>
      ) : (
        <div className="recorder-live" dir="ltr">
          <span className="rec-dot" />
          <span className="rec-time">{fmtDuration(elapsed)}</span>
          <div className="wave live">{recent.map((v, i) => <span key={i} className="on" style={{ height: `${15 + Math.min(1, v * 4) * 85}%` }} />)}</div>
        </div>
      )}
      {rec ? (
        <button className="send-btn ready" onClick={() => onDone(voiceOf(rec))} aria-label="ارسال"><Icon name="send" /></button>
      ) : (
        <button className="send-btn ready rec-stop" onClick={() => stop.current(true)} aria-label="پایان ضبط"><Icon name="stop" /></button>
      )}
    </div>
  );
}

// ---------- round video messages ----------

export const NOTE_MAX = 60_000;
const NOTE_BPS: Record<number, number> = { 384: 1_000_000, 480: 1_500_000, 640: 2_500_000 };
// H.264 in mp4 first: iPhones (Element X, FluffyChat on iOS) can't play webm. Never a bare "video/mp4": Chrome then picks VP9.
// Linux Chrome has no AAC encoder, hence the Opus variant.
const NOTE_TYPES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,opus", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const R = 47, C = 2 * Math.PI * R;

const noteOf = (blob: Blob, duration: number, px: number): Voice => {
  const type = blob.type || "video/webm";
  return {
    file: new File([blob], `video-note.${type.includes("mp4") ? "mp4" : "webm"}`, { type }),
    // other clients show an ordinary (square) video
    extra: { body: "پیام ویدیویی", "app.panbeh.video_note": true, info: { duration: Math.round(duration), w: px, h: px } },
  };
};

/** A round video message from the front camera, square-cropped, up to a minute. Same controls as VoiceRecorder, with the
 *  camera shown in a circle above the composer. */
export function VideoNoteRecorder({ onDone, locked, dx, control }: RecProps) {
  const [rec, setRec] = useState<{ blob: Blob; url: string; duration: number; px: number; poster: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [play, setPlay] = useState({ on: false, pos: 0 }); // the preview's playback
  const cam = useRef<HTMLVideoElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const [front, setFront] = useState(true);
  const [cams, setCams] = useState(0);
  const flip = useRef(() => {});
  const stop = useRef<(keep: boolean) => void>(() => {});
  const sendOnStop = useRef(false);
  const lockedNow = useRef(locked);
  lockedNow.current = locked;

  useEffect(() => {
    let live = true, keep = false, timer = 0, draw = 0, url = "";
    let stream: MediaStream | undefined, r: MediaRecorder | undefined;
    const release = () => { clearInterval(timer); clearInterval(draw); stream?.getTracks().forEach((t) => t.stop()); };
    stop.current = (k) => {
      keep = k;
      if (r?.state === "recording") r.stop();
      else if (sendOnStop.current) onDone();
      release();
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 } }); // like VoiceRecorder: echo cancelling puts Android's mic in call mode
      } catch {
        alertDialog("دسترسی به دوربین یا میکروفون ممکن نشد. اجازه‌ی آن‌ها را در تنظیمات مرورگر یا برنامه بدهید.");
        return onDone();
      }
      if (!live) return release();
      const v = cam.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});
      void navigator.mediaDevices.enumerateDevices().then((d) => setCams(d.filter((x) => x.kind === "videoinput").length));
      // front ↔ back mid-recording: the canvas keeps drawing from the <video> (holding the last frame during the swap),
      // so the recording just carries on. The old camera closes first: many phones can't open two at once.
      let facing = "user", busy = false;
      const open = (f: string) => navigator.mediaDevices.getUserMedia({ video: { facingMode: f, width: { ideal: 1280 }, height: { ideal: 720 } } }).then((s) => s.getVideoTracks()[0]);
      flip.current = async () => {
        if (busy || !stream) return;
        busy = true;
        const old = stream.getVideoTracks()[0], next = facing === "user" ? "environment" : "user";
        stream.removeTrack(old); old.stop();
        const t = await open(next).then((t) => (facing = next, t), () => open(facing).catch(() => undefined)); // no such camera: back to the old one
        if (t && live) {
          stream.addTrack(t);
          v.srcObject = new MediaStream([t]);
          await v.play().catch(() => {});
          setFront(facing === "user");
        } else t?.stop();
        busy = false;
      };
      // the camera's frame cropped to its middle square, so every camera (and orientation) gives a square video
      const px = +loadPrefs().noteQuality;
      const canvas = Object.assign(document.createElement("canvas"), { width: px, height: px }), g = canvas.getContext("2d")!;
      const frame = () => {
        const w = v.videoWidth, h = v.videoHeight, sq = Math.min(w, h);
        if (sq) g.drawImage(v, (w - sq) / 2, (h - sq) / 2, sq, sq, 0, 0, px, px);
      };
      frame();
      draw = window.setInterval(frame, 1000 / 30);
      const out = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...stream.getAudioTracks()]);
      r = new MediaRecorder(out, { mimeType: NOTE_TYPES.find((t) => MediaRecorder.isTypeSupported(t)), videoBitsPerSecond: NOTE_BPS[px], audioBitsPerSecond: AUDIO_BPS[loadPrefs().audioQuality] });
      const chunks: Blob[] = [];
      const started = Date.now();
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        if (!keep || !live) return;
        const blob = new Blob(chunks, { type: r!.mimeType.split(";")[0] }), duration = Math.min(NOTE_MAX, Date.now() - started);
        if (sendOnStop.current) return onDone(duration < MIN_MS ? undefined : noteOf(blob, duration, px));
        url = URL.createObjectURL(blob);
        setRec({ blob, url, duration, px, poster: canvas.toDataURL("image/jpeg", 0.85) }); // the last frame, until it plays
      };
      timer = window.setInterval(() => {
        const e = Date.now() - started;
        setElapsed(e);
        if (e < NOTE_MAX) return;
        if (!lockedNow.current) sendOnStop.current = true; // the minute's up: held sends, locked goes to the preview
        stop.current(true);
      }, 100);
      r.start(1000);
    })();
    return () => { live = false; stop.current(false); if (url) URL.revokeObjectURL(url); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  control.current = { finish: (send) => { if (send) { sendOnStop.current = true; stop.current(true); } else { stop.current(false); onDone(); } } };

  const toggle = () => {
    const el = preview.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {}); else el.pause();
  };
  const f = rec ? (play.pos * 1000) / rec.duration : Math.min(1, elapsed / NOTE_MAX);
  return (
    <>
      <div className="note-backdrop" aria-hidden />
      <div className="note-live">
        {rec ? (
          <video ref={preview} src={rec.url} poster={rec.poster} autoPlay playsInline disablePictureInPicture onClick={toggle}
            onPlay={() => setPlay((p) => ({ ...p, on: true }))} onPause={() => setPlay((p) => ({ ...p, on: false }))}
            onEnded={(e) => { e.currentTarget.currentTime = 0; setPlay({ on: false, pos: 0 }); }}
            onTimeUpdate={(e) => setPlay((p) => ({ ...p, pos: e.currentTarget.currentTime }))} />
        ) : <video ref={cam} muted playsInline className={front ? "mirror" : undefined} />}
        {(!rec || play.on) && <svg viewBox="0 0 100 100" aria-hidden><circle cx="50" cy="50" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(1, f))} /></svg>}
        {rec && !play.on && <span className="play-badge" aria-hidden><Icon name="play" size={26} /></span>}
      </div>
      {!rec && cams > 1 && <button className="note-flip" onClick={() => void flip.current()} title="چرخش دوربین" aria-label="چرخش دوربین"><Icon name="flip" /></button>}
      {!locked && !rec ? <HeldRow elapsed={elapsed} dx={dx} icon="camera" /> : (
        <div className="composer-row recorder">
          <button className="icon-btn" onClick={() => onDone()} title="حذف" aria-label="حذف"><Icon name="trash" /></button>
          <div className="recorder-live" dir="ltr">
            {!rec && <span className="rec-dot" />}
            <span className="rec-time">{fmtDuration(rec?.duration ?? elapsed)}</span>
          </div>
          {rec ? (
            <button className="send-btn ready" onClick={() => onDone(noteOf(rec.blob, rec.duration, rec.px))} aria-label="ارسال"><Icon name="send" /></button>
          ) : (
            <button className="send-btn ready rec-stop" onClick={() => stop.current(true)} aria-label="پایان ضبط"><Icon name="stop" /></button>
          )}
        </div>
      )}
    </>
  );
}
