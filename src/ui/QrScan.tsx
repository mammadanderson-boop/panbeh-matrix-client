import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons.tsx";

const MATRIX = [77, 65, 84, 82, 73, 88]; // "MATRIX": verification codes start with it; other QR codes are ignored

/** The camera, scanning for another device's verification code; `onCode` gets its raw bytes (once). jsQR is loaded on open. */
export function QrScan({ onCode, onClose }: { onCode: (bytes: Uint8ClampedArray) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true, timer = 0, stream: MediaStream | undefined;
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch {
        if (live) setError("دوربین در دسترس نیست. اجازه‌ی دوربین را بدهید یا شکلک‌ها را مقایسه کنید.");
        return;
      }
      const jsQR = (await import("jsqr")).default;
      if (!live) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});
      // a timer, not requestAnimationFrame: a few frames a second is plenty, and it keeps the CPU calm
      const scan = () => {
        if (!live) return;
        if (v.videoWidth) {
          const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
          canvas.width = Math.round(v.videoWidth * k);
          canvas.height = Math.round(v.videoHeight * k);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const hit = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
          if (hit && MATRIX.every((b, i) => hit.binaryData[i] === b)) { live = false; onCode(new Uint8ClampedArray(hit.binaryData)); return; }
        }
        timer = window.setTimeout(scan, 150);
      };
      scan();
    })();
    return () => { live = false; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return (
    <div className="qr-scan">
      {error ? <p className="error">{error}</p> : <><video ref={video} muted playsInline /><span className="qr-frame" aria-hidden /></>}
      <button className="icon-btn qr-scan-close" onClick={onClose} title="بستن" aria-label="بستن"><Icon name="close" /></button>
    </div>
  );
}
