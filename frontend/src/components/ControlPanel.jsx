import { useMemo } from "react";

// Strictly chronological order (matches MapView): undated stops sort last.
function chronologicalSort(list) {
  return [...list].sort((a, b) => {
    const da = a.start_date || "9999-12-31";
    const db = b.start_date || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

export default function ControlPanel({
  stops,
  viewCount,
  source,
  showLines,
  onToggleLines,
  showStates,
  onToggleStates,
  onRecenter,
  onGeocode,
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
  .marker{width:26px;height:26px;border-radius:50%;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45)}
  .marker-amb{background:#d97706}
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
  var icon=L.divIcon({className:"",html:'<div class="marker'+(s.ambiguous?" marker-amb":"")+'">'+s.order+"</div>",iconSize:[26,26],iconAnchor:[13,13],popupAnchor:[0,-15]});
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
        <button onClick={exportHtml} disabled={!canExport} className={`col-span-2 ${btnCls}`}>
          ⬇ Export interactive map (HTML)
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
