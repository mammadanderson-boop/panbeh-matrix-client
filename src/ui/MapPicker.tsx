import { t } from "../i18n.ts";
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Icon } from "../icons.tsx";
import { alertDialog } from "./dialog.tsx";
import { num } from "../logic.ts";

/** Where the map opens before a GPS fix arrives (Tehran). */
const TEHRAN: [number, number] = [35.6892, 51.389];

/** Everything location, Telegram-style: any spot on a map (the pin stays in the middle and the map moves under it),
 *  the GPS fix itself, or live sharing (`onLive`, where it's allowed). Opens on the user when the position comes
 *  quickly enough (`canLocate`: not where there's no location source). */
export function MapPicker({ canLocate, onClose, onPick, onPickSelf, onLive }: {
  canLocate: boolean; onClose: () => void; onPick: (lat: number, lon: number) => void;
  onPickSelf: (lat: number, lon: number, acc: number) => void; onLive?: () => void;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const me = useRef<L.CircleMarker | null>(null);
  const moved = useRef(false); // the user picked a spot: a late GPS fix mustn't take the map away from it
  const [moving, setMoving] = useState(false);
  const [center, setCenter] = useState<L.LatLng>(L.latLng(TEHRAN));
  const [locating, setLocating] = useState(canLocate); // the fix at open starts right away
  const [fix, setFix] = useState<{ lat: number; lon: number; acc: number } | null>(null); // the last GPS fix, for "send my location"

  /** The user's position: silently at open (the map just stays where it is), with an error on the button. */
  function locate(auto = false) {
    if (!navigator.geolocation) return void (auto || alertDialog(t("loc.unsupported")));
    setLocating(true);
    navigator.geolocation.getCurrentPosition((p) => {
      setLocating(false);
      setFix({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) });
      const m = map.current;
      if (!m || (auto && moved.current)) return;
      const ll = L.latLng(p.coords.latitude, p.coords.longitude);
      if (me.current) me.current.setLatLng(ll);
      else me.current = L.circleMarker(ll, { radius: 7, weight: 3, color: "#fff", fillColor: "#1a73e8", fillOpacity: 1, interactive: false }).addTo(m);
      m.setView(ll, Math.max(m.getZoom(), 16), { animate: !auto });
    }, (e) => {
      setLocating(false);
      if (!auto) alertDialog(e.code === e.PERMISSION_DENIED ? t("loc.denied") : t("loc.notFound"));
    }, { enableHighAccuracy: true, timeout: 10_000 });
  }

  useEffect(() => {
    const el = mapEl.current!;
    const m = L.map(el).setView(TEHRAN, 13);
    m.attributionControl.setPrefix(false);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">OpenStreetMap</a>' }).addTo(m);
    map.current = m;
    m.on("dragstart", () => { moved.current = true; });
    m.on("click", (e) => { moved.current = true; m.panTo(e.latlng); });
    m.on("movestart", () => setMoving(true));
    m.on("moveend", () => { setMoving(false); setCenter(m.getCenter()); });
    // the dialog sizes the map (and resizes it with the window or the keyboard): Leaflet only watches the window
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el);
    el.focus({ preventScroll: true }); // Escape closes, arrows pan
    if (canLocate) locate(true);
    return () => { ro.disconnect(); m.remove(); map.current = null; me.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = center.wrap(); // panning past the date line runs longitude beyond ±180
  const lat = +pick.lat.toFixed(6), lon = +pick.lng.toFixed(6);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal map-modal" role="dialog" aria-label={t("loc.title")} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>{t("loc.title")}</h2>
        <div className="map-wrap">
          <div className="map" ref={mapEl} />
          <svg className={`map-pin${moving ? " lifted" : ""}`} viewBox="0 0 24 24" fillRule="evenodd" aria-hidden="true">
            <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
          </svg>
          {canLocate && (
            <button className="icon-btn map-locate" title={t("loc.mine")} aria-label={t("loc.mine")} onClick={() => locate()}>
              <Icon name="location" />
            </button>
          )}
          {locating && <div className="map-locating"><span className="spinner inline" /> {t("loc.locating")}</div>}
        </div>
        <p className="muted">{t("loc.drag")} <bdi dir="ltr">{lat.toFixed(5)}, {lon.toFixed(5)}</bdi></p>
        {(canLocate || onLive) && (
          <div className="map-options">
            {/* the GPS fix itself, not the pin; its accuracy is in sight, so no confirm */}
            {canLocate && (
              <button disabled={!fix} onClick={() => fix && onPickSelf(+fix.lat.toFixed(6), +fix.lon.toFixed(6), fix.acc)}>
                <Icon name="location" />
                <span>{t("loc.sendCurrent")}<small>{fix ? t("loc.accuracy", { count: fix.acc }) : locating ? t("loc.locating") : t("loc.notFoundTap")}</small></span>
              </button>
            )}
            {onLive && (
              <button onClick={onLive}>
                <Icon name="clock" />
                <span>{t("loc.shareLive")}<small>{t("loc.shareLiveHint")}</small></span>
              </button>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button className="primary" onClick={() => onPick(lat, lon)}>{t("loc.sendPoint")}</button>
        </div>
      </div>
    </div>
  );
}
