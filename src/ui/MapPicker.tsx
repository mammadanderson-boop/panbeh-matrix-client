import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Icon } from "../icons.tsx";
import { alertDialog } from "./dialog.tsx";

/** Where the map opens before a GPS fix arrives (Tehran); instantly replaced below once the fix lands. */
const TEHRAN: [number, number] = [35.6892, 51.389];

/** The pin, drawn as markup so no icon images are needed. */
const pinIcon = () => L.divIcon({
  className: "map-pin",
  html: '<svg viewBox="0 0 24 24" fill-rule="evenodd"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/></svg>',
  iconSize: [30, 38],
  iconAnchor: [15, 36],
});

/** Choosing any spot on a map: opens centered on the user (best effort), then the pin is dragged or the map tapped. */
export function MapPicker({ onClose, onPick }: { onClose: () => void; onPick: (lat: number, lon: number) => void }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pin = useRef<L.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [locating, setLocating] = useState(false);

  function setPin(ll: L.LatLngExpression) {
    const m = map.current;
    if (!m) return;
    if (!pin.current) pin.current = L.marker(ll, { icon: pinIcon(), draggable: true }).addTo(m);
    else pin.current.setLatLng(ll);
  }

  /** The user's position: silently at open (the map just starts elsewhere), with an error toast on the button. */
  function locate(auto = false) {
    if (!navigator.geolocation) return auto || alertDialog("این مرورگر موقعیت مکانی را پشتیبانی نمی‌کند.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition((p) => {
      setLocating(false);
      const ll = L.latLng(p.coords.latitude, p.coords.longitude);
      setPin(ll);
      map.current?.setView(ll, Math.max(map.current.getZoom(), 15));
    }, () => { setLocating(false); auto || alertDialog("موقعیت مکانی پیدا نشد."); }, { enableHighAccuracy: true, timeout: 10_000 });
  }
  useEffect(() => { if (ready) locate(true); }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = mapEl.current;
    if (!el) return;
    const m = L.map(el).setView(TEHRAN, 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(m);
    map.current = m;
    setPin(TEHRAN);
    m.on("click", (e) => setPin(e.latlng));
    setReady(true);
    const t = setTimeout(() => m.invalidateSize(), 200); // the modal's open animation moves the container
    return () => { clearTimeout(t); m.remove(); map.current = null; pin.current = null; };
  }, []);

  function send() {
    const ll = pin.current?.getLatLng();
    if (!ll) return;
    onPick(+ll.lat.toFixed(6), +ll.lng.toFixed(6));
  }

  return (
    <div className="modal-backdrop map-backdrop" onClick={onClose}>
      <div className="modal map-modal" role="dialog" aria-label="ارسال از نقشه" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>ارسال از نقشه</h2>
        <div className="map-wrap" ref={mapEl}>
          <button className="icon-btn map-locate" title="موقعیت من" aria-label="موقعیت من" onClick={() => locate()}>
            <Icon name="location" />
          </button>
          {locating && <div className="map-locating"><span className="spinner inline" /> در حال پیدا کردن موقعیت…</div>}
        </div>
        <p className="muted">نشانگر را بکشید یا روی نقشه بزنید تا جای دلخواهتان انتخاب شود.</p>
        <div className="modal-actions">
          <button onClick={onClose}>لغو</button>
          <button className="primary" onClick={send}>ارسال موقعیت</button>
        </div>
      </div>
    </div>
  );
}
