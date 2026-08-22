import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const START_CENTER = [20, 10];
const START_ZOOM = 2;

// Deterministic colors per area name (string hash → hue) so polygons never
// flicker to a different color on re-render / batch updates. The golden-angle
// multiplier spreads neighboring hash values into distinct hues, and we return
// a fill + darker stroke pair for a richer look on the map.
function areaColors(key) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hue = ((h % 360) * 137.508) % 360;
  return {
    fill: `hsl(${hue}, 72%, 55%)`,
    stroke: `hsl(${hue}, 55%, 30%)`,
  };
}

// Deterministic LIGHT pastel per country name. Still clearly visible on the
// basemap (55% sat / 78% light) but lighter than the state fills so the states
// stay the hero once the traveller has visited them.
function countryColors(key) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hue = ((h % 360) * 137.508) % 360;
  return {
    fill: `hsl(${hue}, 55%, 78%)`,
    stroke: `hsl(${hue}, 45%, 64%)`,
  };
}

// Convert a Nominatim GeoJSON geometry to Leaflet polygon rings. Returns an
// array of rings, where each ring is an array of [lat, lng] pairs.
function geoToLatLngs(geojson) {
  if (!geojson) return [];
  const flip = (ring) => ring.map(([lng, lat]) => [lat, lng]);
  if (geojson.type === "Polygon") return [flip(geojson.coordinates[0])];
  if (geojson.type === "MultiPolygon") {
    return geojson.coordinates.map((poly) => flip(poly[0]));
  }
  return [];
}

// Shared canvas renderer keeps hundreds of polygon vertices light on
// low-end hardware (no SVG DOM nodes per city).
const canvasRenderer = L.canvas({ padding: 0.5 });

// Strictly chronological order for the polyline: undated stops sort last.
function chronologicalSort(list) {
  return [...list].sort((a, b) => {
    const da = a.start_date || "9999-12-31";
    const db = b.start_date || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

function numberedIcon(order, ambiguous) {
  const color = ambiguous ? "#d97706" : "#2563eb";
  const svg = `<svg width="34" height="42" viewBox="0 0 34 42" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 1C8.2 1 1 8.2 1 17c0 12.2 16 24 16 24s16-11.8 16-24C33 8.2 25.8 1 17 1z" fill="${color}" stroke="#ffffff" stroke-width="2"/>
  <circle cx="17" cy="16.5" r="9" fill="#ffffff"/>
  <text x="17" y="20.5" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" font-weight="700" fill="${color}">${order}</text>
  </svg>`;
  return L.divIcon({
    className: "tj-pin",
    html: svg,
    iconSize: [34, 42],
    iconAnchor: [17, 42], // tip of the pin
    popupAnchor: [0, -44],
  });
}

function MapController({ positioned, flySignal, focus }) {
  const map = useMap();

  useEffect(() => {
    if (!positioned.length) return;
    const latlngs = positioned.map((s) => [s.lat, s.lng]);
    if (latlngs.length === 1) {
      map.setView(latlngs[0], 12);
    } else {
      map.fitBounds(latlngs, { padding: [40, 40] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flySignal, positioned.length]);

  useEffect(() => {
    if (!focus.stamp) return;
    const s = positioned.find((p) => p.order === focus.order);
    if (s) {
      map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 11), { duration: 0.8 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.stamp]);

  return null;
}

export default function MapView({
  stops,
  showLines,
  flySignal,
  focus,
  showStates = true,
  showCountries = true,
}) {
  const positioned = useMemo(
    () => chronologicalSort(stops.filter((s) => s.lat != null && s.lng != null)),
    [stops],
  );
  const countries = useMemo(() => {
    const map = new Map();
    for (const s of positioned) {
      const name = s.country_name;
      const geo = s.country_geojson;
      if (!name || !geo || map.has(name)) continue;
      map.set(name, geo);
    }
    return [...map.entries()];
  }, [positioned]);
  const areas = useMemo(() => {
    const map = new Map();
    for (const s of positioned) {
      const geo = s.state_geojson || s.geojson;
      if (!geo) continue;
      // Dedupe by state when a state polygon exists (one fill per state),
      // otherwise fall back to per-city polygons (state fetch may have
      // failed, e.g. small countries without admin boundary data).
      const key = s.state_geojson
        ? s.state_name || s.exact_location || s.location
        : s.exact_location || s.location;
      if (map.has(key)) continue;
      map.set(key, geo);
    }
    return [...map.entries()];
  }, [positioned]);
  const line = positioned.map((s) => [s.lat, s.lng]);
  const [legendOpen, setLegendOpen] = useState(true);

  return (
    <div className="relative h-full w-full">
      <MapContainer center={START_CENTER} zoom={START_ZOOM} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
        />

        {/* Country-level light fills — drawn beneath the state fills. */}
        {showCountries &&
          countries.flatMap(([name, geo]) => {
            const rings = geoToLatLngs(geo);
            if (!rings.length) return [];
            const { fill, stroke } = countryColors(name);
            return rings.map((latlngs, i) => (
              <Polygon
                key={`country-${name}-${i}`}
                positions={latlngs}
                pathOptions={{
                  color: stroke,
                  fillColor: fill,
                  fillOpacity: 0.65,
                  weight: 1.5,
                  opacity: 0.9,
                  renderer: canvasRenderer,
                }}
              />
            ));
          })}

        {/* State/region boundary fills — override the country colour where the
            traveller actually visited, so visited states clearly pop. */}
        {showStates &&
          areas.flatMap(([key, geo]) => {
            const rings = geoToLatLngs(geo);
            if (!rings.length) return [];
            const { fill, stroke } = areaColors(key);
            return rings.map((latlngs, i) => (
              <Polygon
                key={`area-${key}-${i}`}
                positions={latlngs}
                pathOptions={{
                  color: stroke,
                  fillColor: fill,
                  fillOpacity: 0.9,
                  weight: 2.5,
                  opacity: 0.95,
                  renderer: canvasRenderer,
                }}
              />
            ));
          })}

        {showLines && line.length > 1 && (
          <>
            <Polyline positions={line} pathOptions={{ color: "#ffffff", weight: 6, opacity: 0.9 }} />
            <Polyline positions={line} pathOptions={{ color: "#2563eb", weight: 3, opacity: 0.9 }} />
          </>
        )}

        {positioned.map((s) => (
          <Marker
            key={`${s.order}-${s.lat}-${s.lng}-${s.is_ambiguous ? "amb" : "ok"}`}
            position={[s.lat, s.lng]}
            icon={numberedIcon(s.order, s.is_ambiguous)}
          >
            <Tooltip direction="top" offset={[0, -34]} opacity={0.95} className="tj-tip">
              <span className="text-xs font-medium">
                {s.order}. {s.location}
              </span>
            </Tooltip>
            <Popup>
              <div className="min-w-[150px] text-xs">
                <div className="font-bold">
                  {s.order}. {s.location}
                </div>
                {s.exact_location && s.exact_location !== s.location && (
                  <div className="mt-0.5 text-[10px] text-slate-400">{s.exact_location}</div>
                )}
                {(s.start_date || s.end_date) && (
                  <div className="mt-0.5 text-slate-600">
                    {s.start_date || "?"}
                    {s.end_date && s.end_date !== s.start_date ? ` → ${s.end_date}` : ""}
                  </div>
                )}
                {s.category && (
                  <span className="mt-0.5 inline-block rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                    {s.category}
                  </span>
                )}
                {s.notes && <div className="mt-0.5 text-slate-500">{s.notes}</div>}
                {s.is_ambiguous && (
                  <div className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-[10px] text-amber-700">
                    ⚠ {s.warning || "Ambiguous location — verify the region."}
                  </div>
                )}
              </div>
            </Popup>
          </Marker>
        ))}

        <MapController positioned={positioned} flySignal={flySignal} focus={focus} />
      </MapContainer>

      {/* Collapsible color legend for the visited country/state fills. */}
      {(showStates && areas.length > 0) || (showCountries && countries.length > 0) ? (
        <div className="absolute bottom-3 right-3 z-[1000] w-48 overflow-hidden rounded-lg border border-slate-200 bg-white/95 shadow-lg">
          <button
            onClick={() => setLegendOpen((v) => !v)}
            className="flex w-full items-center justify-between px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            <span>🗺️ Visited areas</span>
            <span className="text-slate-400">{legendOpen ? "▾" : "▸"}</span>
          </button>
          {legendOpen && (
            <div className="max-h-52 overflow-y-auto border-t border-slate-100 px-2 py-1.5">
              {showCountries &&
                countries.map(([name]) => (
                  <div key={name} className="flex items-center gap-1.5 py-[3px] text-[11px] text-slate-600">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[3px] border border-white shadow-sm"
                      style={{ background: countryColors(name).fill }}
                    />
                    <span className="truncate">{name}</span>
                  </div>
                ))}
              {showCountries && countries.length > 0 && areas.length > 0 && (
                <div className="my-1 border-t border-slate-100" />
              )}
              {showStates &&
                areas.map(([key]) => (
                  <div key={key} className="flex items-center gap-1.5 py-[3px] text-[11px] text-slate-600">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[3px] border border-white shadow-sm"
                      style={{ background: areaColors(key).fill }}
                    />
                    <span className="truncate">{key}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      ) : null}

      {!positioned.length && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-xl bg-white/90 px-5 py-4 text-center shadow">
            <div className="text-2xl">🧭</div>
            <p className="mt-1 text-sm font-medium text-slate-600">Your journey will appear here</p>
            <p className="text-xs text-slate-400">Upload an itinerary to plot your stops</p>
          </div>
        </div>
      )}
    </div>
  );
}
