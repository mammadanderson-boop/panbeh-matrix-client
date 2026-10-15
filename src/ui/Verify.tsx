import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { renderSVG } from "uqr";
import { CryptoEvent, VerificationPhase, VerificationRequestEvent, VerifierEvent, type ShowQrCodeCallbacks, type ShowSasCallbacks, type UserVerificationStatus, type VerificationRequest } from "matrix-js-sdk/lib/crypto-api/index.js";
import { client } from "../matrix.ts";
import { useTick } from "../hooks.ts";
import { num } from "../logic.ts";
import { Icon } from "../icons.tsx";
import { bdi, errText, Sheet } from "./common.tsx";
import { QrScan } from "./QrScan.tsx";

// ---------- the one verification on screen (incoming or started from Settings/Profile) ----------
let current: VerificationRequest | null = null;
const subs = new Set<() => void>();
export const showVerification = (r: VerificationRequest | null) => { current = r; subs.forEach((f) => f()); };
const useCurrent = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);
const finished = (r: VerificationRequest) => r.phase === VerificationPhase.Done || r.phase === VerificationPhase.Cancelled;

/** Shows incoming verification requests; `onTrustChange` re-checks the recovery banner (secrets arrive by gossip after self-verification). */
export function VerificationListener({ onTrustChange }: { onTrustChange: () => void }) {
  const req = useCurrent();
  const trustChanged = useRef(onTrustChange);
  trustChanged.current = onTrustChange; // a new function every Shell render; don't resubscribe for it
  useEffect(() => {
    // one at a time: a second request while one is in progress is left to time out
    const onRequest = (r: VerificationRequest) => { if (!current || finished(current)) showVerification(r); };
    const onTrust = () => trustChanged.current();
    client.on(CryptoEvent.VerificationRequestReceived, onRequest);
    client.on(CryptoEvent.KeyBackupDecryptionKeyCached, onTrust);
    client.on(CryptoEvent.UserTrustStatusChanged, onTrust);
    return () => {
      client.off(CryptoEvent.VerificationRequestReceived, onRequest);
      client.off(CryptoEvent.KeyBackupDecryptionKeyCached, onTrust);
      client.off(CryptoEvent.UserTrustStatusChanged, onTrust);
    };
  }, []);
  return req ? <VerificationSheet key={req.transactionId ?? ""} req={req} /> : null;
}

/** Cross-signing trust of a user, refreshed when it changes; undefined while loading. */
export function useUserTrust(userId: string) {
  const [s, setS] = useState<UserVerificationStatus>();
  useEffect(() => {
    const check = () => { client.getCrypto()?.getUserVerificationStatus(userId).then(setS, () => {}); };
    check();
    client.on(CryptoEvent.UserTrustStatusChanged, check);
    return () => { client.off(CryptoEvent.UserTrustStatusChanged, check); };
  }, [userId]);
  return s;
}

const started = new WeakSet<object>(); // verify() once per verifier

/** req.scanQRCode, around an SDK bug: we show our own code and scan theirs on one request (Element never does both), and the
 *  SDK keeps the verifier of the code we show, so the request stays "ready" here though the scan went out and the other side
 *  asks to confirm. With no verifier, its change hook adopts the scan's.
 *  ponytail: matrix-js-sdk privates (_verifier, onChange); drop when the SDK swaps QR verifiers itself (checked on 43.0.0) */
async function scanCode(req: VerificationRequest, bytes: Uint8ClampedArray) {
  await req.scanQRCode(bytes);
  const r = req as unknown as { _verifier?: unknown; onChange?: () => void };
  if (req.phase === VerificationPhase.Ready && typeof r.onChange === "function") {
    r._verifier = undefined;
    r.onChange();
  }
}

function VerificationSheet({ req }: { req: VerificationRequest }) {
  useTick(req, [VerificationRequestEvent.Change]);
  const [sas, setSas] = useState<ShowSasCallbacks | null>(null);
  const [reciprocate, setReciprocate] = useState<ShowQrCodeCallbacks | null>(null); // they scanned our code: did it work there?
  const [qr, setQr] = useState<string | null>(null); // our code, as SVG
  const [scanning, setScanning] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [scanned, setScanned] = useState(false); // we scanned their code: they confirm it there
  const [error, setError] = useState("");
  const verifier = req.verifier;
  const run = (fn: () => Promise<unknown>) => fn().catch((e) => setError(errText(e)));

  useEffect(() => {
    if (!verifier) return;
    setSas(verifier.getShowSasCallbacks());
    setReciprocate(verifier.getReciprocateQrCodeCallbacks());
    verifier.on(VerifierEvent.ShowSas, setSas);
    verifier.on(VerifierEvent.ShowReciprocateQr, setReciprocate);
    if (!started.has(verifier)) {
      started.add(verifier);
      verifier.verify().catch(() => {}); // cancellation shows up as the request's phase
    }
    return () => { verifier.off(VerifierEvent.ShowSas, setSas); verifier.off(VerifierEvent.ShowReciprocateQr, setReciprocate); };
  }, [verifier]);

  // ready: show our code if they can scan it. Without QR on either side, we asked: start the emoji comparison at once
  const canScan = req.phase === VerificationPhase.Ready && req.otherPartySupportsMethod("m.qr_code.show.v1");
  const autoStarted = useRef(false);
  useEffect(() => {
    if (req.phase !== VerificationPhase.Ready || req.verifier) return;
    if (req.otherPartySupportsMethod("m.qr_code.scan.v1")) {
      req.generateQRCode().then((b) => b && setQr(renderSVG([...b], { border: 2 })), () => {});
    } else if (req.initiatedByMe && !req.otherPartySupportsMethod("m.qr_code.show.v1") && !autoStarted.current) {
      autoStarted.current = true;
      run(() => req.startVerification("m.sas.v1"));
    }
  }, [req.phase]);

  const close = () => {
    if (!finished(req)) req.cancel().catch(() => {});
    showVerification(null);
  };
  const self = req.isSelfVerification;
  const other = self ? "دستگاه دیگرتان" : bdi(client.getUser(req.otherUserId)?.displayName ?? req.otherUserId);

  let body;
  switch (req.phase) {
    case VerificationPhase.Unsent:
    case VerificationPhase.Requested:
      body = req.initiatedByMe ? (
        <>
          <p>{self ? "پنبه یا برنامه‌ی دیگری را که با آن وارد شده‌اید باز کنید و درخواست تأیید را بپذیرید." : `منتظر پذیرش درخواست توسط ${other}…`}</p>
          <span className="spinner inline" />
        </>
      ) : (
        <>
          <p>{self ? "یکی دیگر از دستگاه‌های شما می‌خواهد این دستگاه را تأیید کند." : `${other} می‌خواهد هویت شما را تأیید کند.`}</p>
          <div className="verify-actions">
            <button onClick={close}>رد کردن</button>
            <button className="primary" disabled={req.accepting} onClick={() => run(() => req.accept())}>پذیرفتن</button>
          </div>
        </>
      );
      break;
    case VerificationPhase.Ready:
      body = scanning ? (
        <QrScan onClose={() => setScanning(false)} onCode={(b) => { setScanning(false); setScanned(true); run(() => scanCode(req, b)); }} />
      ) : qr || canScan ? (
        <>
          {qr && <>
            <p>{`این کد را با ${other} اسکن کنید.`}</p>
            <div className="qr" role="img" aria-label="کد QR تأیید" dangerouslySetInnerHTML={{ __html: qr }} />
          </>}
          {canScan && <button className={qr ? "" : "primary"} onClick={() => setScanning(true)}><Icon name="camera" size={18} /> {`اسکن کد ${other}`}</button>}
          <button onClick={() => run(() => req.startVerification("m.sas.v1"))}>مقایسه‌ی شکلک‌ها</button>
        </>
      ) : req.initiatedByMe ? <span className="spinner inline" /> : (
        <>
          <p>درخواست پذیرفته شد. شکلک‌ها را در هر دو دستگاه مقایسه کنید.</p>
          <button className="primary" onClick={() => run(() => req.startVerification("m.sas.v1"))}>مقایسه‌ی شکلک‌ها</button>
        </>
      );
      break;
    case VerificationPhase.Started:
      body = reciprocate && !sas ? (confirmed ? <span className="spinner inline" /> : (
        <>
          <p>{`${other} کد شما را اسکن کرد. آیا آنجا «کد اسکن شد» با علامت تیک نمایش داده می‌شود؟`}</p>
          <div className="verify-actions">
            <button onClick={() => reciprocate.cancel()}>خیر</button>
            <button className="primary" onClick={() => { setConfirmed(true); reciprocate.confirm(); }}>بله</button>
          </div>
        </>
      )) : !sas && scanned ? (
        <>
          <p className="card ok"><Icon name="check" size={18} /> کد اسکن شد</p>
          <p>{`در ${other} «بله» را بزنید.`}</p>
          <span className="spinner inline" />
        </>
      ) : !sas ? <><p>{`منتظر ${other}…`}</p><span className="spinner inline" /></> : confirmed ? (
        <><p>{`منتظر تأیید ${other}…`}</p><span className="spinner inline" /></>
      ) : (
        <>
          <p>{`تأیید کنید که شکلک‌های زیر در ${other} هم به همین ترتیب نمایش داده می‌شوند.`}</p>
          {sas.sas.emoji ? (
            <div className="sas-emoji" dir="ltr">
              {sas.sas.emoji.map(([e, name], i) => <div key={i}><span>{e}</span><small>{EMOJI_FA[name.toLowerCase()] ?? name}</small></div>)}
            </div>
          ) : <p className="sas-decimal" dir="ltr">{sas.sas.decimal?.map((n) => num(n)).join("  ")}</p>}
          <div className="verify-actions">
            <button onClick={() => sas.mismatch()}>مطابقت ندارند</button>
            <button className="primary" onClick={() => { setConfirmed(true); run(() => sas.confirm()); }}>مطابقت دارند</button>
          </div>
        </>
      );
      break;
    case VerificationPhase.Done:
      body = (
        <>
          <p className="card ok"><Icon name="check" size={18} /> {self ? "این دستگاه تأیید شد." : `هویت ${other} تأیید شد.`}</p>
          <button className="primary" onClick={close}>بستن</button>
        </>
      );
      break;
    default:
      body = (
        <>
          <p className="error">{CANCEL_REASONS[req.cancellationCode ?? ""] ?? "تأیید لغو شد."}</p>
          <button className="primary" onClick={close}>بستن</button>
        </>
      );
  }

  return (
    <Sheet title={self ? "تأیید دستگاه" : "تأیید هویت"} onClose={close}>
      <div className="verify">
        {body}
        {error && <p className="error">{error}</p>}
      </div>
    </Sheet>
  );
}

const CANCEL_REASONS: Record<string, string> = {
  "m.mismatched_sas": "شکلک‌ها مطابقت نداشتند؛ تأیید لغو شد.",
  "m.user": "تأیید لغو شد.",
  "m.timeout": "مهلت تأیید تمام شد.",
  "m.accepted": "درخواست در دستگاه دیگری پاسخ داده شد.",
};

// SAS emoji names (spec order), keyed by the SDK's English name
const EMOJI_FA: Record<string, string> = {
  dog: "سگ", cat: "گربه", lion: "شیر", horse: "اسب", unicorn: "تک‌شاخ", pig: "خوک", elephant: "فیل", rabbit: "خرگوش",
  panda: "پاندا", rooster: "خروس", penguin: "پنگوئن", turtle: "لاک‌پشت", fish: "ماهی", octopus: "هشت‌پا", butterfly: "پروانه", flower: "گل",
  tree: "درخت", cactus: "کاکتوس", mushroom: "قارچ", globe: "کره‌ی زمین", moon: "ماه", cloud: "ابر", fire: "آتش", banana: "موز",
  apple: "سیب", strawberry: "توت‌فرنگی", corn: "ذرت", pizza: "پیتزا", cake: "کیک", heart: "قلب", smiley: "لبخند", robot: "ربات",
  hat: "کلاه", glasses: "عینک", spanner: "آچار", santa: "بابانوئل", "thumbs up": "لایک", umbrella: "چتر", hourglass: "ساعت شنی", clock: "ساعت",
  gift: "هدیه", "light bulb": "لامپ", book: "کتاب", pencil: "مداد", paperclip: "گیره", scissors: "قیچی", lock: "قفل", key: "کلید",
  hammer: "چکش", telephone: "تلفن", flag: "پرچم", train: "قطار", bicycle: "دوچرخه", aeroplane: "هواپیما", rocket: "موشک", trophy: "جام",
  ball: "توپ", guitar: "گیتار", trumpet: "شیپور", bell: "زنگ", anchor: "لنگر", headphones: "هدفون", folder: "پوشه", pin: "سنجاق",
};
