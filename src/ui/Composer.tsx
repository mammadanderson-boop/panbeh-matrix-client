import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ContentHelpers, LocationAssetType, M_BEACON_INFO, MsgType, type IContent, type MatrixEvent, type Room } from "matrix-js-sdk";
import { client, emoteMap, emotesFor, GIF_INFO, loadEvent, scheduleMessage, startUpload, type Emote } from "../matrix.ts";
import { getDraft, setDraft, showingDraft } from "../drafts.ts";
import { isNative, captureCameraPhoto, pickGalleryPhotos, clipboardImages, nativeHoldIme } from "../native.ts";
import { Icon } from "../icons.tsx";
import { Avatar, bdi, ContextMenu, errText, formatSize, me, senderName, stripReplyFallback, toast } from "./common.tsx";
import { clock, deleteBack, escRe, formatMessage, prefixLines, toggleWrap, normalize, num, neshanUrl, scheduleLabel, type Gif } from "../logic.ts";
import { isMessage } from "../hooks.ts";
import { VideoNoteRecorder, VoiceRecorder, type RecControl, type Voice } from "./Voice.tsx";
import { PollForm } from "./Poll.tsx";
import { EmojiPanel, EmoteImg, PreviewText } from "./Emoji.tsx";
import { caretOf, EmoteInput, focusAt, placeCaret } from "./EmoteInput.tsx";
import { alertDialog, promptDialog } from "./dialog.tsx";
import { isSendKey, loadPrefs } from "./Settings.tsx";
import { useExit } from "./useDismiss.ts";
import { useLongPress } from "./useLongPress.ts";
import { SchedulePicker, ScheduledList, useScheduled } from "./Scheduled.tsx";
import { DURATIONS, sharingIn, startSharing, stopSharing } from "../liveLocation.ts";
import { isDesktop } from "../desktop.ts";

// Leaflet only loads when the map opens
const MapPicker = lazy(() => import("./MapPicker.tsx").then((m) => ({ default: m.MapPicker })));

export type Mode = { kind: "reply" | "edit"; ev: MatrixEvent } | null;
const MEDIA = ["m.image", "m.video", "m.file"];
// Chromium on Linux has no system location source, only Google's network service, which needs an API key Electron doesn't ship: hide location there
const noGeo = isDesktop && navigator.userAgent.includes("Linux");
/** Touch: the emoji panel sits where the keyboard was (Telegram-style) instead of popping up over the chat. */
const DOCK = matchMedia("(pointer: coarse)").matches;
const KB_KEY = "panbeh.kbHeight";
let kbH = Number(localStorage.getItem(KB_KEY)) || 0; // the keyboard's last height: the docked panel's
export const EDITABLE = ["m.text", "m.emote", "m.notice", ...MEDIA];
/** A media message's caption (MSC2530): body differs from filename; otherwise body is just the name. */
export const captionOf = (c: IContent): string => (c.filename && c.body !== c.filename ? c.body ?? "" : "");

/** Files pasted into a composer box. On Android the WebView hands the paste event no image (it stays on the system
 *  clipboard as a content:// URI), so the native side reads it off the clipboard like a picked photo. */
function pasteFiles(e: ClipboardEvent, setFiles: (f: (x: File[]) => File[]) => void) {
  const f = [...e.clipboardData.files];
  if (f.length) { e.preventDefault(); setFiles((x) => [...x, ...f]); return; }
  if (isNative) clipboardImages().then((g) => g?.length && setFiles((x) => [...x, ...g]));
}

const LOCK_AT = 60, CANCEL_AT = 100; // px the held finger slides up to lock, sideways to cancel

type Props = { room: Room; threadId: string | null; mode: Mode; setMode: (m: Mode) => void; files: File[]; setFiles: (f: (x: File[]) => File[]) => void };
type Mention = { name: string; id: string };
type Suggestion = Mention & { mxc?: string | null; emote?: Emote };

export function Composer({ room, threadId, mode, setMode, files, setFiles }: Props) {
  const draftKey = room.roomId + (threadId ?? "");
  const [text, setText] = useState(getDraft(draftKey)?.body ?? "");
  const mediaEdit = mode?.kind === "edit" && MEDIA.includes(mode.ev.getContent().msgtype ?? "");
  const [menu, setMenu] = useState(false);
  const [menuShown, menuClosing] = useExit(menu);
  const [pollForm, setPollForm] = useState(false);
  // recording a voice or video message: held while the finger is down (slide up locks, slide toward the text cancels)
  const [rec, setRec] = useState<{ kind: "voice" | "video"; locked: boolean; dx: number } | null>(null);
  const recording = !!rec;
  const recControl = useRef<RecControl | null>(null);
  const [recordMode, setRecordMode] = useState(() => loadPrefs().recordMode);
  const [livePick, setLivePick] = useState(false);
  const [mapPick, setMapPick] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [emojiShown, emojiClosing] = useExit(emoji && !recording, 220); // outlasts the docked panel's slide
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [selEnd, setSelEnd] = useState(0); // past `caret` when text is selected: the format bar shows
  const [closedAt, setClosedAt] = useState(-1); // Esc hides the mention list for this "@"
  const sched = useScheduled(room);
  const canSched = sched.ok && !threadId; // a thread reply needs the thread's latest event, unknown until it goes out
  const [sendMenu, setSendMenu] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [schedList, setSchedList] = useState(false);
  const sendPress = useLongPress(canSched ? (x, y) => { if (text.trim() && mode?.kind !== "edit") setSendMenu({ x, y }); } : undefined);
  const ta = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { // the composer floats over the timeline; tell it how much room to leave at the bottom
    const el = root.current!, host = el.parentElement!;
    // without the docked emoji panel: the timeline ends above it (--emoji-gap), so its fade covers the row only
    const ro = new ResizeObserver(() => host.style.setProperty("--composer-h", el.offsetHeight - (el.querySelector<HTMLElement>(".emoji-dock")?.offsetHeight ?? 0) + "px"));
    ro.observe(el);
    return () => { ro.disconnect(); host.style.removeProperty("--composer-h"); };
  }, []);
  // The WebView shrinks by the keyboard. Under the row the composer keeps a gap of (panel - keyboard), so while the
  // panel is open the row stays put as one replaces the other; the panel leaves once the keyboard is back up.
  const emojiOn = useRef(emoji);
  emojiOn.current = emoji;
  const fit = useRef((_toggled?: boolean) => {});
  useEffect(() => {
    if (!DOCK) return;
    const el = root.current!, host = el.parentElement!;
    let full = 0, width = 0;
    fit.current = (toggled = false) => {
      const h = host.clientHeight;
      if (host.clientWidth !== width) { width = host.clientWidth; full = 0; } // rotated: a new baseline
      full = Math.max(full, h);
      const kb = full - h, up = kb > 120, on = emojiOn.current;
      if (up && !on && kb !== kbH) { kbH = kb; localStorage.setItem(KB_KEY, String(kb)); }
      if (up && on && document.activeElement === ta.current) setEmoji(false); // typing again: the keyboard took over
      const panel = kbH || Math.round(full * 0.4);
      const search = !!document.activeElement?.closest(".emoji-panel"); // its search box: panel over the keyboard
      el.style.setProperty("--emoji-h", panel + "px");
      host.style.setProperty("--emoji-gap", (on ? (search ? panel : Math.max(0, panel - kb)) : 0) + "px"); // the timeline makes room too
      host.classList.toggle("emoji-slide", toggled && !up); // opened or closed with no keyboard: it slides; swaps with the keyboard mustn't
    };
    const ro = new ResizeObserver(() => fit.current());
    ro.observe(host);
    const focus = () => fit.current();
    addEventListener("focusin", focus);
    return () => { ro.disconnect(); removeEventListener("focusin", focus); host.style.removeProperty("--emoji-gap"); };
  }, []);
  useLayoutEffect(() => fit.current(true), [emoji]);
  useEffect(() => { // docked: a tap outside the composer closes it (a scroll doesn't click); a rising keyboard covers it first
    if (!DOCK || !emoji) return;
    nativeHoldIme(true);
    const out = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (root.current!.contains(t)) return;
      setEmoji(false);
      if (t.closest(".timeline-wrap")) { e.preventDefault(); e.stopPropagation(); } // a tap on the chat only closes it, as with the keyboard
    };
    addEventListener("click", out, true);
    return () => { nativeHoldIme(false); removeEventListener("click", out, true); };
  }, [emoji]);
  const backToKb = useRef(0);
  function toggleEmoji() {
    if (!DOCK) return setEmoji((x) => !x);
    clearTimeout(backToKb.current);
    if (emoji) return focusAt(ta.current); // ⌨
    setEmoji(true);
    ta.current?.blur(); // the keyboard goes down, the panel is already in its place
  }
  const fileInput = useRef<HTMLInputElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const camInput = useRef<HTMLInputElement>(null);
  const typingAt = useRef(0);
  const stash = useRef(""); // the draft, put aside while editing a message
  const editing = useRef(false);
  const mentions = useRef<Mention[]>([]); // people picked from the @ list; turned into links on send

  // the main chat's draft keeps its reply target. One being restored (from storage or another device) waits here
  // until its event loads into `mode` (null: the draft has none); any mode change ends the wait
  const pendingReply = useRef<string | null | undefined>(threadId ? undefined : getDraft(draftKey)?.reply);
  const lastMode = useRef(mode);
  function restoreReply(id: string | undefined) {
    const cur = lastMode.current;
    if (cur?.kind === "edit" || (cur?.kind === "reply" ? cur.ev.getId() : undefined) === id) return;
    pendingReply.current = id ?? null;
    if (!id) return setMode(null);
    loadEvent(room, id).then((ev) => { if (pendingReply.current === id) setMode({ kind: "reply", ev }); },
      () => { if (pendingReply.current === id) pendingReply.current = undefined; }); // gone: just the text
  }
  useEffect(() => {
    if (threadId) return;
    if (pendingReply.current) restoreReply(pendingReply.current);
    // another device's edit: taken unless we're typing here (then ours is newer and wins on upload)
    return showingDraft(room.roomId, (d) => {
      if (editing.current || document.activeElement === ta.current) return;
      restoreReply(d.reply);
      setText(d.body);
    });
  }, []);
  useEffect(() => {
    const reply = pendingReply.current !== undefined ? pendingReply.current ?? undefined : mode?.kind === "reply" ? mode.ev.getId() : undefined;
    setDraft(draftKey, editing.current ? stash.current : text, threadId ? undefined : reply);
  }, [draftKey, text, mode]);
  const mounted = useRef(false);
  useEffect(() => {
    const restored = mode !== lastMode.current && pendingReply.current !== undefined; // a draft's reply coming back: no focus
    if (mode !== lastMode.current) { lastMode.current = mode; pendingReply.current = undefined; }
    const edit = mode?.kind === "edit";
    if (edit && !editing.current) stash.current = text;
    if (edit) {
      const c = mode.ev.getContent();
      setText(mediaEdit ? captionOf(c) : stripReplyFallback(c.body ?? ""));
      // keep the original's mentions as links in the edit
      mentions.current = (c["m.mentions"]?.user_ids ?? []).map((id: string) => ({ id, name: room.getMember(id)?.name ?? id }));
    } else if (editing.current) setText(stash.current); // edit sent/cancelled, or switched to reply
    editing.current = edit;
    // opening a chat must not pop the keyboard on touch devices; reply/edit always focuses
    if (!mounted.current && !matchMedia("(pointer: fine)").matches) mounted.current = true;
    else if (!restored) { mounted.current = true; focusAt(ta.current); }
  }, [mode]);

  useEffect(() => () => { // left the room mid-typing
    if (typingAt.current) client.sendTyping(room.roomId, false, 0).catch(() => {});
    typingAt.current = 0;
  }, [room.roomId]);

  // ---------- @ mentions, :custom emoji ----------
  const emotes = emoteMap(room); // what's sent as images, and shown as them in the box
  const at = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  const colon = !at && /(^|\s):([^\s:]{2,})$/.exec(text.slice(0, caret));
  const atPos = at ? caret - at[2].length - 1 : colon ? caret - colon[2].length - 1 : -1;
  const suggestions: Suggestion[] = [];
  if (colon && atPos !== closedAt) {
    const q = normalize(colon[2]), seen = new Set<string>();
    for (const e of emotesFor(room, "emoticon")) {
      if (suggestions.length >= 6 || seen.has(e.code) || !normalize(e.code).includes(q)) continue;
      seen.add(e.code); // the first pack's wins, as on send
      suggestions.push({ id: ":" + e.code + ":", name: e.pack.name, emote: e });
    }
  }
  if (at && atPos !== closedAt) {
    const q = normalize(at[2]);
    suggestions.push(...room.getJoinedMembers()
      .filter((m) => m.userId !== me() && normalize(m.name + " " + m.userId).includes(q))
      .slice(0, 6).map((m) => ({ id: m.userId, name: m.name, mxc: m.getMxcAvatarUrl() })));
    if ("room".startsWith(q) && room.currentState.mayTriggerNotifOfType("room", me())) suggestions.push({ id: "@room", name: "room" });
  }
  useEffect(() => { if (at) room.loadMembersIfNeeded().catch(() => {}); }, [!!at, room]);

  function pick(s: Suggestion) {
    const insert = s.emote ? s.id + " " : "@" + s.name + " ";
    const next = text.slice(0, atPos) + insert + text.slice(caret);
    if (s.id !== "@room" && !s.emote) mentions.current.push({ name: s.name, id: s.id });
    const c = atPos + insert.length;
    setText(next);
    setCaret(c);
    requestAnimationFrame(() => focusAt(ta.current, c));
  }

  function typing(on: boolean) {
    const now = Date.now();
    if (on && now - typingAt.current < 3000) return;
    typingAt.current = on ? now : 0;
    client.sendTyping(room.roomId, on, 5000).catch(() => {});
  }

  /** body + optional HTML with mention links, and the m.mentions that decides who gets pinged. */
  function compose(body: string) {
    // "@Name" / "@user:server" typed out without picking from the list counts too
    const typed = room.getJoinedMembers().filter((m) => m.userId !== me())
      .flatMap((m) => [{ name: m.name, id: m.userId }, { name: m.userId.slice(1), id: m.userId }])
      .filter((m) => new RegExp("@" + escRe(m.name) + "(?![\\p{L}\\p{N}_])", "u").test(body));
    const html = formatMessage(body, [...mentions.current, ...typed], emotes);
    const ids = new Set(html?.ids);
    const replyTo = mode?.kind === "reply" ? mode.ev.getSender() : undefined;
    if (replyTo && replyTo !== me()) ids.add(replyTo); // spec: a reply mentions who it replies to
    const everyone = /(^|\s)@room\b/.test(body) && room.currentState.mayTriggerNotifOfType("room", me());
    return {
      body,
      ...(html && { format: "org.matrix.custom.html", formatted_body: html.html }),
      "m.mentions": { user_ids: [...ids], ...(everyone && { room: true }) },
    };
  }

  function send() {
    const body = text.trim();
    if (!body && !mediaEdit) return;
    setText("");
    typing(false);
    if (mode?.kind === "edit") {
      const old = mode.ev.getContent();
      if (body !== (mediaEdit ? captionOf(old) : stripReplyFallback(old.body ?? ""))) {
        let next: ReturnType<typeof compose> & Record<string, unknown> = { msgtype: old.msgtype, ...compose(body) };
        if (mediaEdit) { // the replacement is the whole content: keep the file, swap the caption (empty = file name only)
          const base = { ...old };
          for (const k of ["format", "formatted_body", "m.relates_to", "m.mentions"]) delete base[k];
          const name = old.filename ?? old.body;
          next = { ...base, ...(body ? compose(body) : { body: name, "m.mentions": { user_ids: [] } }), filename: name } as typeof next;
        }
        const before = new Set<string>(old["m.mentions"]?.user_ids ?? []);
        client.sendMessage(room.roomId, {
          ...(mediaEdit ? next : { msgtype: old.msgtype }), body: "* " + next.body,
          "m.new_content": next,
          // only people newly mentioned by the edit get pinged
          "m.mentions": { user_ids: next["m.mentions"].user_ids.filter((id) => !before.has(id)) },
          "m.relates_to": { rel_type: "m.replace", event_id: mode.ev.getId()! },
        } as never);
      }
    } else client.sendMessage(room.roomId, threadId, newContent(body) as never);
    mentions.current = [];
    setMode(null);
  }

  /** A new text message (not an edit): mentions, formatting, the reply. */
  function newContent(body: string) {
    const content: Record<string, unknown> = { msgtype: MsgType.Text, ...compose(body) };
    if (mode?.kind === "reply") content["m.relates_to"] = { "m.in_reply_to": { event_id: mode.ev.getId() } };
    return content;
  }

  /** The text, held by the server until `sendAt` (main timeline only: a thread reply needs the thread's latest event). */
  function schedule(sendAt: number) {
    const body = text.trim();
    if (!body) return;
    const content = newContent(body);
    setText("");
    typing(false);
    mentions.current = [];
    setMode(null);
    scheduleMessage(room, content, sendAt).then(() => toast(`برای ${scheduleLabel(sendAt)} زمان‌بندی شد`), (e) => {
      alertDialog(errText(e));
      setText((t) => t || body); // not lost, unless they've started another
    });
  }

  function sendFiles(list: File[], caption: string, asFile: boolean, asGif: boolean, sendAt?: number) {
    const replyTo = mode?.kind === "reply" ? mode.ev : undefined;
    setMode(null);
    setFiles(() => []);
    const gif = (f: File) => asGif && !asFile && f.type.startsWith("video/");
    const media = list.filter((f) => !asFile && /^(image|video)\//.test(f.type) && f.type !== "image/gif" && !gif(f));
    // photos and videos go as albums of up to 10 (Telegram's limit), each tagged so Panbeh shows them as one grid.
    // The reply goes on the first, the caption on the last of the first album: other clients show it after the photos.
    const albums = media.length > 1 ? Array.from({ length: Math.ceil(media.length / 10) }, (_, k) => media.slice(k * 10, k * 10 + 10)) : [];
    const firstAlbum = albums[0];
    // the caption's markdown, emoji and mentions, as a text message's (its body stays the caption: sendFile sets it)
    const { body: _, ...rich } = caption ? compose(caption) : { body: "" };
    for (const a of albums) {
      const id = crypto.randomUUID();
      a.forEach((f, i) => {
        const captioned = a === firstAlbum && i === a.length - 1;
        startUpload(room, f, threadId, a === firstAlbum && !i ? replyTo : undefined,
          { "app.panbeh.album": { id, n: a.length, i }, ...(captioned && rich) }, captioned ? caption : undefined, false, sendAt);
      });
    }
    const rest = list.filter((f) => !albums.flat().includes(f));
    rest.forEach((f, i) => {
      const captioned = !albums.length && !i;
      startUpload(room, f, threadId, captioned ? replyTo : undefined, { ...(gif(f) && { info: GIF_INFO }), ...(captioned && rich) },
        captioned ? caption : undefined, asFile, sendAt);
    });
  }

  /** The GPS position is the user (m.self, with its accuracy); a spot chosen on the map is a pin (m.pin). */
  function sendLocation(lat: number, lon: number, asset: LocationAssetType, acc?: number) {
    // body keeps a map link for clients that don't show locations
    const content: Record<string, unknown> = ContentHelpers.makeLocationContent(`موقعیت مکانی ${neshanUrl(lat, lon)}`, `geo:${lat},${lon}${acc ? `;u=${acc}` : ""}`, Date.now(), null, asset);
    if (mode?.kind === "reply") content["m.relates_to"] = { "m.in_reply_to": { event_id: mode.ev.getId() } };
    setMode(null);
    client.sendMessage(room.roomId, threadId, content as never).catch((e) => alertDialog(errText(e)));
  }

  /** عکس: on Android the gallery opens straight away (the system photo picker on 13+, the gallery app before);
   *  elsewhere a file dialog filtered to images. */
  async function pickPhotos() {
    if (isNative) {
      const f = await pickGalleryPhotos();
      if (f) { if (f.length) setFiles((x) => [...x, ...f]); return; }
    }
    imgInput.current?.click();
  }

  /** دوربین: on Android the camera app opens straight away and the full-size capture lands in the send dialog;
   *  on mobile web the capture input does it (the item is hidden on desktop, which ignores capture). */
  async function takePhoto() {
    if (isNative) {
      const f = await captureCameraPhoto();
      if (f) { if (f.length) setFiles((x) => [...x, ...f]); return; }
    }
    camInput.current?.click();
  }

  /** چسباندن از کلیپ‌بورد: the image copied in another app. Android's WebView hides it from the paste event, so it's
   *  read straight off the clipboard through the plugin; anything else there is nothing to send. */
  async function pasteClipboard() {
    const f = await clipboardImages();
    if (f?.length) setFiles((x) => [...x, ...f]);
    else toast("عکسی در کلیپ‌بورد نیست");
  }

  /** Markdown markers around the selection (or "> " before its lines), the same text left selected. */
  function format(mark: string) {
    const el = ta.current;
    if (!el) return;
    const [a, b] = caretOf(el);
    const r = a === b ? null : mark === "> " ? prefixLines(text, a, b, mark) : toggleWrap(text, a, b, mark);
    if (!r) return;
    setText(r.text);
    requestAnimationFrame(() => placeCaret(el, r.a, r.b));
  }
  async function addLink() {
    const el = ta.current!, [a, b] = caretOf(el), label = text.slice(a, b).trim();
    if (!label) return;
    const url = await promptDialog("نشانی لینک", { placeholder: "https://…", ok: "افزودن" });
    if (url) {
      const link = `[${label}](${/^https?:\/\//i.test(url) ? url : "https://" + url})`;
      setText(text.slice(0, a) + link + text.slice(b));
      requestAnimationFrame(() => focusAt(el, a + link.length));
    } else focusAt(el);
  }
  // Telegram Desktop's keys, by the physical key so they work on a Persian layout too
  const FORMAT_KEYS: Record<string, string> = { KeyB: "**", KeyI: "*", KeyU: "__", "shift+KeyX": "~~", "shift+KeyM": "`", "shift+KeyP": "||" };

  function onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && selEnd > caret) {
      const mark = FORMAT_KEYS[(e.shiftKey ? "shift+" : "") + e.code];
      if (mark || (e.code === "KeyK" && !e.shiftKey)) { e.preventDefault(); return mark ? format(mark) : void addLink(); }
    }
    if (suggestions.length) {
      const i = sel % suggestions.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setSel((i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); pick(suggestions[i]); return; }
      if (e.key === "Escape") { e.preventDefault(); setClosedAt(atPos); return; }
    }
    if (isSendKey(e)) { e.preventDefault(); send(); }
    else if (e.key === "Escape" && mode) setMode(null);
    else if (e.key === "ArrowUp" && !text && !mode) { // ↑ edits your last message
      const tl = threadId ? room.getThread(threadId)?.liveTimeline : room.getLiveTimeline();
      const mine = tl?.getEvents().findLast((ev) => ev.getSender() === me() && !ev.status && isMessage(ev) && EDITABLE.includes(ev.getContent().msgtype ?? ""));
      if (mine) { e.preventDefault(); setMode({ kind: "edit", ev: mine }); }
    }
  }

  /** Emoji at the caret (replacing a selection); the caret ends up after it for the next pick. */
  function insert(s: string) {
    const el = ta.current;
    const [a, b] = el ? caretOf(el) : [text.length, text.length];
    setText(text.slice(0, a) + s + text.slice(b));
    const c = a + s.length;
    setCaret(c);
    requestAnimationFrame(() => el && placeCaret(el, c));
  }

  /** The emoji panel's ⌫, at the caret like insert(). */
  function backspace() {
    const el = ta.current;
    const [a, b] = el ? caretOf(el) : [text.length, text.length];
    const [t, c] = deleteBack(text, a, b, emotes.keys());
    setText(t);
    setCaret(c);
    requestAnimationFrame(() => el && placeCaret(el, c));
  }

  function sendSticker(s: Emote) {
    setEmoji(false);
    const content: Record<string, unknown> = { body: s.img.body || s.code, url: s.img.url, info: s.img.info ?? {} };
    if (mode?.kind === "reply") content["m.relates_to"] = { "m.in_reply_to": { event_id: mode.ev.getId() } };
    client.sendEvent(room.roomId, threadId, "m.sticker" as never, content as never).catch((e) => alertDialog(errText(e)));
    setMode(null);
  }

  function sendGif(g: Gif) {
    setEmoji(false);
    const content: Record<string, unknown> = { ...g };
    if (mode?.kind === "reply") content["m.relates_to"] = { "m.in_reply_to": { event_id: mode.ev.getId() } };
    client.sendMessage(room.roomId, threadId, content as never).catch((e) => alertDialog(errText(e)));
    setMode(null);
  }

  function recorded(v?: Voice) {
    recControl.current = null;
    setRec(null);
    if (!v) return;
    startUpload(room, v.file, threadId, mode?.kind === "reply" ? mode.ev : undefined, v.extra);
    setMode(null);
  }

  /** Mic button: a tap switches voice ↔ video; holding records, up to lock, sideways (toward the text) to cancel. */
  function holdRecord(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); // no focus change, no text selection, no long-press menu
    const id = e.pointerId, x0 = e.clientX, y0 = e.clientY, kind = recordMode;
    let started = false, over = false;
    const timer = window.setTimeout(() => { started = true; navigator.vibrate?.(20); setRec({ kind, locked: false, dx: 0 }); }, 200);
    const done = () => { over = true; clearTimeout(timer); removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); };
    function move(ev: PointerEvent) {
      if (ev.pointerId !== id || !started || over) return;
      const dx = Math.min(0, ev.clientX - x0), dy = ev.clientY - y0;
      if (dy < -LOCK_AT) { done(); navigator.vibrate?.(15); setRec((r) => r && { ...r, locked: true, dx: 0 }); }
      else if (dx < -CANCEL_AT) { done(); recControl.current?.finish(false); }
      else setRec((r) => r && { ...r, dx });
    }
    function up(ev: PointerEvent) {
      if (ev.pointerId !== id || over) return;
      done();
      if (!started) { // a tap: switch what the button records
        const next = kind === "voice" ? "video" : "voice";
        setRecordMode(next);
        localStorage.setItem("panbeh.prefs", JSON.stringify({ ...loadPrefs(), recordMode: next }));
        toast(next === "video" ? "برای ضبط پیام ویدیویی نگه دارید" : "برای ضبط پیام صوتی نگه دارید");
      } else recControl.current?.finish(ev.type === "pointerup");
    }
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  }

  const canRecord = !text.trim() && mode?.kind !== "edit" && "MediaRecorder" in window;
  const attachAway = !!text.trim() || mode?.kind === "edit";
  const hasSched = canSched && sched.list.length > 0; // its button sits by attach and slides away with it
  const canCamera = isNative || matchMedia("(pointer: coarse)").matches; // a desktop file dialog can't take a photo

  const FORMATS: [string, string, ReactNode][] = [["**", "پررنگ", <b>B</b>], ["*", "کج", <i>I</i>], ["__", "زیرخط", <u>U</u>],
    ["~~", "خط‌خورده", <s>S</s>], ["`", "کد", <code>{"</>"}</code>], ["||", "اسپویلر", <span className="fmt-spoiler">S</span>], ["> ", "نقل‌قول", "”"]];
  const bar = (
    <>
      {selEnd > caret && (
        // onMouseDown: focus (the phone's keyboard, the selection) stays in the text box
        <div className="format-bar" role="toolbar" aria-label="قالب‌بندی" onMouseDown={(e) => e.preventDefault()}>
          {FORMATS.map(([mark, label, glyph]) => <button key={mark} className="icon-btn" title={label} aria-label={label} onClick={() => format(mark)}>{glyph}</button>)}
          <button className="icon-btn" title="لینک" aria-label="لینک" onClick={addLink}><Icon name="link" /></button>
        </div>
      )}
      {mode && (
        <div className="composer-mode">
          <Icon name={mode.kind === "edit" ? "edit" : "reply"} />
          <div>
            <b>{mode.kind === "edit" ? "ویرایش پیام" : `پاسخ به ${bdi(senderName(mode.ev))}`}</b>
            <span><PreviewText ev={mode.ev} /></span>
          </div>
          <button className="icon-btn" aria-label="لغو" onClick={() => setMode(null)}><Icon name="close" /></button>
        </div>
      )}
    </>
  );

  const kbBtn = DOCK && emoji; // ⌨ in place of 😊 while the panel stands in for the keyboard
  const emojiPanel = emojiShown && <EmojiPanel closing={emojiClosing} docked={DOCK} room={room} onEmoji={(k, custom) => insert(custom ? k + " " : k)} onBackspace={backspace} onClose={() => setEmoji(false)}
    gifs={mode?.kind === "edit" ? undefined : { onPick: sendGif }} stickers={mode?.kind === "edit" ? undefined : { onPick: sendSticker }} />;

  return (
    <div className="composer" ref={root}>
      {suggestions.length > 0 && (
        <div className="mention-list" role="listbox" aria-label={colon ? "اموجی" : "نام بردن"}>
          {suggestions.map((s, i) => (
            <button key={s.id} role="option" aria-selected={i === sel % suggestions.length} className={"user-row" + (i === sel % suggestions.length ? " on" : "")}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
              {s.emote ? <span className="mention-room emote-sug"><EmoteImg url={s.emote.img.url} alt="" /></span>
                : s.id === "@room" ? <span className="mention-room"><Icon name="group" /></span> : <Avatar mxc={s.mxc} name={s.name} id={s.id} size={32} />}
              {s.emote ? <span><b dir="ltr">{s.id}</b><small>{s.name}</small></span>
                : <span><b>{s.id === "@room" ? "@room" : s.name}</b><small dir="ltr">{s.id === "@room" ? "همه‌ی اعضای گفتگو" : s.id}</small></span>}
            </button>
          ))}
        </div>
      )}
      {recording && bar}
      {rec && (rec.kind === "video" ? <VideoNoteRecorder {...rec} control={recControl} onDone={recorded} /> : <VoiceRecorder {...rec} control={recControl} onDone={recorded} />)}
      {/* stays mounted (hidden) while recording: unmounting the focused textarea would drop the keyboard, and the
          held mic button would jump with the layout */}
      <div className={"composer-row" + (rec ? " behind-rec" : "")} aria-hidden={recording || undefined}>
        {/* RTL: first child sits on the right — send/mic there, the pill on the left */}
        {canRecord ? (
          <button className="send-btn rec-btn" onPointerDown={holdRecord} onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setRec({ kind: recordMode, locked: true, dx: 0 }); } }}
            title={recordMode === "video" ? "پیام ویدیویی: نگه دارید" : "پیام صوتی: نگه دارید"} aria-label={recordMode === "video" ? "ضبط پیام ویدیویی" : "ضبط پیام صوتی"}>
            <Icon key={recordMode} name={recordMode === "video" ? "camera" : "mic"} />
          </button>
        ) : (
          <button className={"send-btn" + (text.trim() || mediaEdit ? " ready" : "")} onClick={sendPress.click(send)} {...sendPress.handlers} aria-label="ارسال"
            onMouseDown={(e) => e.preventDefault()} /* keeps focus (and the phone's keyboard) in the textarea */ disabled={!text.trim() && !mediaEdit}>
            <Icon key={mode?.kind === "edit" ? "check" : "send"} name={mode?.kind === "edit" ? "check" : "send"} />
          </button>
        )}
        {/* one pill — attach, text, emoji (attach slides away while typing) */}
        <div className="composer-field">
          {!recording && bar}
          <div className={"attach" + (attachAway ? " away" : "") + (hasSched ? " two" : "")}>
            {/* outside the menu: picking closes the menu, and an unmounted input never gets its change event */}
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const f = [...e.target.files!]; setFiles((x) => [...x, ...f]); e.target.value = ""; }} />
            <input ref={imgInput} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = [...e.target.files!]; setFiles((x) => [...x, ...f]); e.target.value = ""; }} />
            <input ref={camInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = [...e.target.files!]; setFiles((x) => [...x, ...f]); e.target.value = ""; }} />
            <button className="icon-btn" title="پیوست" aria-label="پیوست" aria-expanded={menu} aria-hidden={attachAway} tabIndex={attachAway ? -1 : undefined} onClick={() => setMenu((m) => !m)}><Icon name="attach" /></button>
            {hasSched && <button className="icon-btn" title="پیام‌های زمان‌بندی‌شده" aria-label="پیام‌های زمان‌بندی‌شده" aria-hidden={attachAway} tabIndex={attachAway ? -1 : undefined}
              onClick={() => setSchedList(true)}><Icon name="clock" /></button>}
            {menuShown && (
              <>
                <div className="menu-backdrop" onClick={() => setMenu(false)} />
                <div className={"attach-menu" + (menuClosing ? " closing" : "")} role="menu" onClick={() => setMenu(false)}>
                  {canCamera && <button role="menuitem" onClick={takePhoto}><Icon name="camera" /> دوربین</button>}
                  <button role="menuitem" onClick={pickPhotos}><Icon name="image" /> عکس و ویدیو</button>
                  {isNative && <button role="menuitem" onClick={pasteClipboard}><Icon name="clipboard" /> چسباندن از کلیپ‌بورد</button>}
                  <button role="menuitem" onClick={() => fileInput.current?.click()}><Icon name="file" /> فایل</button>
                  {/* one location entry: the map opens first, then it's a spot chosen on it, the GPS position or live sharing */}
                  <button role="menuitem" onClick={() => setMapPick(true)}><Icon name="location" /> موقعیت مکانی</button>
                  <button role="menuitem" onClick={() => setPollForm(true)}><Icon name="poll" /> نظرسنجی</button>
                </div>
              </>
            )}
          </div>
          <EmoteInput inputRef={ta} className="composer-text" value={text} emotes={emotes} placeholder={mediaEdit ? "کپشن…" : "پیام"} aria-label="پیام"
            onChange={(t, c) => { if (recording) return; setText(t); setCaret(c); setSelEnd(c); setSel(0); typing(!!t); }}
            onCaret={(c, end) => { setCaret(c); setSelEnd(end); }}
            // a keyboard that doesn't resize the page (a browser tab, a hardware one) never closes the panel by itself
            onFocus={() => { if (DOCK && emoji) backToKb.current = window.setTimeout(() => setEmoji(false), 700); }}
            onKeyDown={onKey} onPaste={(e) => pasteFiles(e, setFiles)} onBlur={() => { setSelEnd(0); if (typingAt.current) typing(false); }} />
          <button className="icon-btn emoji-toggle" title={kbBtn ? "صفحه‌کلید" : "اموجی و استیکر"} aria-label={kbBtn ? "صفحه‌کلید" : "اموجی و استیکر"} aria-expanded={kbBtn ? undefined : emoji}
            onMouseDown={(e) => e.preventDefault()} /* the keyboard stays up until the panel is in its place */ onClick={toggleEmoji}><Icon name={kbBtn ? "keyboard" : "smile"} /></button>
        </div>
      </div>
      {DOCK ? <div className="emoji-dock">{emojiPanel}</div> : emojiPanel}
      {files.length > 0 && <SendFiles room={room} files={files} setFiles={setFiles} onSend={sendFiles} canSchedule={canSched} />}
      {sendMenu && (
        <ContextMenu {...sendMenu} target=".send-btn" onClose={() => setSendMenu(null)}>
          <button role="menuitem" onClick={() => { setSendMenu(null); setPicking(true); }}><Icon name="clock" /> ارسال زمان‌بندی‌شده</button>
        </ContextMenu>
      )}
      {picking && <SchedulePicker onPick={(ts) => { setPicking(false); schedule(ts); }} onClose={() => setPicking(false)} />}
      {schedList && <ScheduledList room={room} list={sched.list} onClose={() => setSchedList(false)} />}
      {pollForm && <PollForm room={room} threadId={threadId} onClose={() => setPollForm(false)} />}
      {livePick && <LiveLocationPicker room={room} onClose={() => setLivePick(false)} />}
      {mapPick && (
        <Suspense fallback={null}>
          <MapPicker canLocate={!noGeo} onClose={() => setMapPick(false)}
            onPick={(lat, lon) => { setMapPick(false); sendLocation(lat, lon, LocationAssetType.Pin); }}
            onPickSelf={(lat, lon, acc) => { setMapPick(false); sendLocation(lat, lon, LocationAssetType.Self, acc); }}
            onLive={!noGeo && room.currentState.maySendStateEvent(M_BEACON_INFO.name, me()) ? () => { setMapPick(false); setLivePick(true); } : undefined} />
        </Suspense>
      )}
    </div>
  );
}

/** Custom emoji by code → mxc; the first pack's wins, as in the suggestions. */
function SendFiles({ room, files, setFiles, onSend, canSchedule }: { room: Room; files: File[]; setFiles: Props["setFiles"]; canSchedule: boolean;
  onSend: (files: File[], caption: string, asFile: boolean, asGif: boolean, sendAt?: number) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const press = useLongPress(canSchedule ? (x, y) => setMenu({ x, y }) : undefined);
  const [caption, setCaption] = useState("");
  const [asFile, setAsFile] = useState(false);
  const [asGif, setAsGif] = useState(false);
  const [urls, setUrls] = useState<(string | null)[]>([]);
  useEffect(() => {
    const u = files.map((f) => (f.type.startsWith("image/") ? URL.createObjectURL(f) : null));
    setUrls(u);
    return () => u.forEach((x) => x && URL.revokeObjectURL(x));
  }, [files]);
  const close = () => setFiles(() => []);
  const send = () => onSend(files, caption.trim(), asFile, asGif);
  const remove = (i: number) => setFiles((x) => x.filter((_, j) => j !== i));
  const imgs = files.map((f, i) => i).filter((i) => urls[i]);
  const others = files.map((f, i) => i).filter((i) => !urls[i]);
  const photos = files.every((f) => f.type.startsWith("image/"));
  const title = files.length === 1 && photos ? "ارسال عکس" : `ارسال ${num(files.length)} ${photos && !asFile ? "عکس" : "فایل"}`;
  const x = (i: number) => <button className="icon-btn send-x" aria-label="حذف" onClick={() => remove(i)}><Icon name="close" size={14} /></button>;
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
        <h2>{title}</h2>
        {imgs.length > 0 && (
          <div className="send-grid">
            {imgs.map((i) => <div key={i} className="send-thumb"><img src={urls[i]!} alt="" />{x(i)}</div>)}
          </div>
        )}
        {others.map((i) => (
          <div key={i} className="file-row send-file">
            <span className="file-icon"><Icon name="file" /></span>
            <span><b>{bdi(files[i].name)}</b><small dir="auto">{formatSize(files[i].size)}</small></span>
            {x(i)}
          </div>
        ))}
        <EmoteInput className="send-caption" autoFocus value={caption} emotes={emoteMap(room)} placeholder="کپشن…" aria-label="کپشن"
          onChange={setCaption}
          onPaste={(e) => pasteFiles(e, setFiles)}
          onKeyDown={(e) => { if (isSendKey(e)) { e.preventDefault(); send(); } }} />
        {imgs.length > 0 && (
          <label className="switch-row"><span>ارسال به صورت فایل<small>بدون فشرده‌سازی</small></span>
            <input type="checkbox" role="switch" checked={asFile} onChange={(e) => setAsFile(e.target.checked)} /></label>
        )}
        {files.some((f) => f.type.startsWith("video/")) && (
          <label className="switch-row"><span>ارسال به صورت گیف<small>پخش خودکار و تکرار، بدون صدا</small></span>
            <input type="checkbox" role="switch" checked={asGif} onChange={(e) => setAsGif(e.target.checked)} /></label>
        )}
        <div className="modal-actions">
          <button onClick={close}>لغو</button>
          <button className="primary" onClick={press.click(send)} {...press.handlers}>ارسال</button>
        </div>
      </div>
      {/* clicks in these must not reach the backdrop, which closes the dialog */}
      <div onClick={(e) => e.stopPropagation()}>
        {menu && (
          <ContextMenu {...menu} target=".modal .primary" onClose={() => setMenu(null)}>
            <button role="menuitem" onClick={() => { setMenu(null); setPicking(true); }}><Icon name="clock" /> ارسال زمان‌بندی‌شده</button>
          </ContextMenu>
        )}
        {picking && <SchedulePicker onPick={(ts) => { setPicking(false); onSend(files, caption.trim(), asFile, asGif, ts); }} onClose={() => setPicking(false)} />}
      </div>
    </div>
  );
}

/** Wraps the chat column; dropping files anywhere on it hands them to `onFiles`. */
export function DropZone({ onFiles, children }: { onFiles: (f: File[]) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const has = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  return (
    <div className="drop-zone"
      onDragEnter={(e) => { if (has(e)) { depth.current++; setOver(true); } }}
      onDragLeave={(e) => { if (has(e) && --depth.current <= 0) { depth.current = 0; setOver(false); } }}
      onDragOver={(e) => has(e) && e.preventDefault()}
      onDrop={(e) => { if (!has(e)) return; e.preventDefault(); depth.current = 0; setOver(false); onFiles([...e.dataTransfer.files]); }}>
      {children}
      {over && <div className="drop-overlay"><Icon name="attach" size={40} />فایل‌ها را اینجا رها کنید</div>}
    </div>
  );
}

/** Live location: pick how long to share this device's position into the room. */
function LiveLocationPicker({ room, onClose }: { room: Room; onClose: () => void }) {
  const active = sharingIn(room.roomId);
  const pick = (ms: number) => {
    onClose();
    if (!active) toast("در حال پیدا کردن موقعیت…"); // a first GPS fix can take a while
    startSharing(client, room, ms).then(
      () => toast(active ? "اشتراک موقعیت زنده تمدید شد" : "اشتراک موقعیت زنده آغاز شد"),
      (e) => alertDialog(errText(e)),
    );
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="اشتراک موقعیت زنده" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>اشتراک موقعیت زنده</h2>
        <p className="muted">موقعیت شما هر ۳۰ ثانیه به‌روزرسانی می‌شود و تا پایان مهلت انتخابی دیده می‌شود.</p>
        {active && <p className="card">اشتراک فعلی تا {clock(active.until)} ادامه دارد؛ انتخاب مهلت جدید آن را جایگزین می‌کند.</p>}
        <div className="modal-actions">
          {active && <button className="danger" onClick={() => { onClose(); stopSharing(client, room.roomId).then(() => toast("اشتراک موقعیت زنده قطع شد"), (e) => alertDialog(errText(e))); }}>قطع اشتراک</button>}
          {DURATIONS.map(([ms, label]) => (
            <button key={ms} className="primary" onClick={() => pick(ms)}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
