import { useMemo, useState } from "react";

// Strictly chronological order (matches MapView): undated stops sort last.
function chronologicalSort(list) {
  return [...list].sort((a, b) => {
    const da = a.start_date || "9999-12-31";
    const db = b.start_date || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

// Great-circle distance in km between two coordinates (cheap, no dependency).
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export default function ControlPanel({
  stops,
  viewCount,
  source,
  showLines,
  onToggleLines,
  showStates,
  onToggleStates,
  showCountries,
  onToggleCountries,
  onRecenter,
  onGeocode,
  journeyTitle,
  onJourneyTitleChange,
  onSaveJourney,
  saving,
  onClear,
  flaggedCount,
  busy,
  view,
  onViewChange,
  years,
  onClearSaved,
}) {
  const positioned = useMemo(
    () => chronologicalSort(stops.filter((s) => s.lat != null && s.lng != null)),
    [stops],
  );
  const canExport = positioned.length > 0;
  const [confirmClear, setConfirmClear] = useState(false);

  // Trip summary: countries visited, rough distance, date span, category mix.
  const summary = useMemo(() => {
    const countries = new Set(
      stops.map((s) => s.country_name).filter(Boolean),
    );
    const dates = stops
      .map((s) => s.start_date || s.end_date)
      .filter(Boolean)
      .sort();
    let distKm = 0;
    for (let i = 1; i < positioned.length; i++) {
      const a = positioned[i - 1];
      const b = positioned[i];
      distKm += haversine(a.lat, a.lng, b.lat, b.lng);
    }
    const byCat = { Past: 0, Current: 0, Upcoming: 0 };
    stops.forEach((s) => {
      if (byCat[s.category] != null) byCat[s.category] += 1;
    });
    return {
      countries: countries.size,
      distKm,
      first: dates[0] || "",
      last: dates[dates.length - 1] || "",
      byCat,
    };
  }, [stops, positioned]);

  const fmtKm = (km) =>
    km >= 1000 ? `${(km / 1000).toFixed(1)}k km` : `${Math.round(km).toLocaleString()} km`;

  const download = (name, content, type) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const exportJson = () => {
    download(
      "itinerary.json",
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sourceType: source?.type ?? null,
          llmUsed: source?.llmUsed ?? null,
          stops,
        },
        null,
        2,
      ),
      "application/json",
    );
  };

  const exportHtml = () => {
    const points = positioned.map((s) => ({
      order: s.order,
      location: s.location,
      exact_location: s.exact_location || "",
      start_date: s.start_date || "",
      end_date: s.end_date || "",
      category: s.category || "",
      notes: s.notes || "",
      lat: s.lat,
      lng: s.lng,
      ambiguous: !!s.is_ambiguous,
      warning: s.warning || "",
    }));
    const json = JSON.stringify(points).replace(/</g, "\\u003c");
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Travel Journey Map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
  html,body,#map{height:100%;margin:0;font-family:system-ui,-apple-system,sans-serif}
  .legend{position:absolute;z-index:1000;bottom:18px;left:18px;background:rgba(255,255,255,.93);padding:8px 12px;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.25);font-size:13px}
  .marker{position:relative;width:34px;height:42px;background:#2563eb;clip-path:path('M17 1C8.2 1 1 8.2 1 17c0 12.2 16 24 16 24s16-11.8 16-24C33 8.2 25.8 1 17 1z');color:#2563eb}
  .marker::after{content:'';position:absolute;left:50%;top:7.5px;width:18px;height:18px;margin-left:-9px;border-radius:50%;background:#fff}
  .marker span{position:absolute;left:50%;top:7px;transform:translateX(-50%);font-size:11px;font-weight:700;z-index:1}
  .marker-amb{background:#d97706;color:#d97706}
  .pop-title{font-weight:700;margin-bottom:2px}
  .pop-meta{color:#475569}
  .pop-warn{margin-top:4px;background:#fffbeb;border:1px solid #fcd34d;border-radius:4px;padding:2px 6px;color:#92400e;font-size:11px}
</style>
</head>
<body>
<div id="map"></div>
<div class="legend">📍 <b>${points.length}</b> stop${points.length === 1 ? "" : "s"} &middot; Travel Journey Map</div>
<script>
var STOPS=${json};
var map=L.map("map");
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",{subdomains:"abcd",attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',maxZoom:19}).addTo(map);
function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML}
var latlngs=STOPS.map(function(s){return[s.lat,s.lng]});
if(latlngs.length>1)L.polyline(latlngs,{color:"#2563eb",weight:3,opacity:.85}).addTo(map);
STOPS.forEach(function(s){
  var icon=L.divIcon({className:"",html:'<div class="marker'+(s.ambiguous?" marker-amb":"")+'"><span>'+s.order+"</span></div>",iconSize:[34,42],iconAnchor:[17,42],popupAnchor:[0,-44]});
  var h='<div class="pop-title">'+s.order+". "+esc(s.location)+"</div>";
  if(s.exact_location&&s.exact_location!==s.location)h+='<div class="pop-meta">'+esc(s.exact_location)+"</div>";
  var dates=[s.start_date,s.end_date].filter(function(d){return d});
  if(dates.length)h+='<div class="pop-meta">'+esc(dates.join(" \u2192 "))+"</div>";
  if(s.category)h+='<div class="pop-meta">'+esc(s.category)+"</div>";
  if(s.notes)h+='<div class="pop-meta">'+esc(s.notes)+"</div>";
  if(s.ambiguous)h+='<div class="pop-warn">\u26a0 '+esc(s.warning||"Ambiguous location")+"</div>";
  L.marker([s.lat,s.lng],{icon:icon}).addTo(map).bindPopup(h)
});
if(latlngs.length===1)map.setView(latlngs[0],12);
else if(latlngs.length>1)map.fitBounds(latlngs,{padding:[40,40]});
else map.setView([20,10],2);
<\/script>
</body>
</html>`;
    download("itinerary_map.html", html, "text/html");
  };

  const btnCls =
    "rounded-md border border-slate-300 px-2 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      {/* Save journey */}
      <div className="mb-3 flex items-center gap-1.5">
        <input
          value={journeyTitle}
          onChange={(e) => onJourneyTitleChange(e.target.value)}
          placeholder="Journey title"
          className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={onSaveJourney}
          disabled={saving || !stops.length || busy}
          className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {saving ? "Saving…" : "💾 Save journey"}
        </button>
      </div>

      {/* Trip summary */}
      {stops.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-1.5 text-[11px]">
          <div className="rounded-md bg-slate-50 px-2 py-1.5">
            <div className="text-slate-400">Countries</div>
            <div className="text-sm font-semibold text-slate-700">🌍 {summary.countries}</div>
          </div>
          <div className="rounded-md bg-slate-50 px-2 py-1.5">
            <div className="text-slate-400">Route length</div>
            <div className="text-sm font-semibold text-slate-700">📏 {fmtKm(summary.distKm)}</div>
          </div>
          {summary.first && (
            <div className="rounded-md bg-slate-50 px-2 py-1.5">
              <div className="text-slate-400">Journey</div>
              <div className="truncate text-sm font-semibold text-slate-700">
                {summary.first} → {summary.last}
              </div>
            </div>
          )}
          <div className="rounded-md bg-slate-50 px-2 py-1.5">
            <div className="text-slate-400">Trips</div>
            <div className="flex items-center gap-1 text-sm font-semibold text-slate-700">
              <span className="text-slate-500">⬆️{summary.byCat.Upcoming}</span>
              <span className="text-emerald-600">●{summary.byCat.Current}</span>
              <span className="text-slate-400">⬇️{summary.byCat.Past}</span>
            </div>
          </div>
        </div>
      )}

      {/* Stats + source badge */}
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className="flex flex-wrap items-center gap-1.5">
          {viewCount} of {stops.length} stop{stops.length !== 1 && "s"} · {positioned.length} on map
          {flaggedCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700">
              ⚠ {flaggedCount} ambiguous
            </span>
          )}
        </span>
        {source && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium capitalize">
            {source.type}
            {source.engine === "llm"
              ? ` · LLM${source.llmModel ? ` (${source.llmModel})` : ""}`
              : source.engine === "structured"
                ? " · structured"
                : " · heuristic"}
          </span>
        )}
      </div>

      {/* Timeline filter */}
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">
        Timeline
      </label>
      <select
        value={view}
        onChange={(e) => onViewChange(e.target.value)}
        className="mb-2 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
      >
        <option value="all">All Trips</option>
        <option value="past">Past Trips</option>
        <option value="current">Current Trip</option>
        <option value="upcoming">Upcoming Trips</option>
        {years.map((y) => (
          <option key={y} value={`year-${y}`}>
            Year: {y}
          </option>
        ))}
      </select>

      {/* Buttons */}
      <div className="grid grid-cols-2 gap-1.5">
        <button onClick={onRecenter} className={btnCls}>
          🎯 Re-center
        </button>
        <button onClick={onToggleLines} className={btnCls}>
          {showLines ? "Hide lines" : "Show lines"}
        </button>
        <button onClick={onGeocode} disabled={busy || !stops.length} className={btnCls}>
          🌐 Re-geocode &amp; check
        </button>
        <button onClick={exportJson} disabled={!canExport} className={btnCls}>
          ⬇ Export JSON
        </button>
        <button
          onClick={onToggleStates}
          className={`col-span-2 ${btnCls} ${
            showStates ? "border-blue-300 bg-blue-50 text-blue-700" : "opacity-70"
          }`}
        >
          🗺️ Color visited states: {showStates ? "on" : "off"}
        </button>
        <button
          onClick={onToggleCountries}
          className={`col-span-2 ${btnCls} ${
            showCountries ? "border-teal-300 bg-teal-50 text-teal-700" : "opacity-70"
          }`}
        >
          🌍 Color the world: {showCountries ? "on" : "off"}
        </button>
        <button onClick={exportHtml} disabled={!canExport} className={`col-span-2 ${btnCls}`}>
          ⬇ Export interactive map (HTML)
        </button>
        <button
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              setTimeout(() => setConfirmClear(false), 3000);
              return;
            }
            setConfirmClear(false);
            onClear();
          }}
          disabled={!stops.length}
          className={`col-span-2 ${btnCls} ${
            confirmClear
              ? "border-red-400 bg-red-600 text-white hover:bg-red-700"
              : "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
          }`}
        >
          {confirmClear ? "⚠ Click again to clear everything" : "🧹 Clear map"}
        </button>
      </div>

      {/* Auto-save status + clear */}
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-100 pt-2 text-[11px] text-slate-400">
        <span>💾 Auto-saved in this browser</span>
        <button
          onClick={onClearSaved}
          disabled={!stops.length}
          className="rounded px-1.5 py-0.5 font-medium text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear saved
        </button>
      </div>
    </div>
  );
}
