import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  Marker,
  Pane,
  Polygon,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fetchFamilyJourneys } from "../api";
import {
  START_CENTER,
  START_ZOOM,
  worldColors,
  countryMatches,
  loadWorldData,
  geoToLatLngs,
  splitRing,
  canvasRenderer,
  chronologicalSort,
  userColor,
} from "../mapShared";

// Per-user pin (coloured teardrop).
function userPin(order, color) {
  const svg = `<svg width="34" height="42" viewBox="0 0 34 42" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 1C8.2 1 1 8.2 1 17c0 12.2 16 24 16 24s16-11.8 16-24C33 8.2 25.8 1 17 1z" fill="${color}" stroke="#ffffff" stroke-width="2"/>
  <circle cx="17" cy="16.5" r="9" fill="#ffffff"/>
  <text x="17" y="20.5" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" font-weight="700" fill="${color}">${order}</text>
  </svg>`;
  return L.divIcon({
    className: "tj-pin",
    html: svg,
    iconSize: [34, 42],
    iconAnchor: [17, 42],
    popupAnchor: [0, -44],
  });
}

export default function FamilyMap({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [worldData, setWorldData] = useState(null);
  const [legendOpen, setLegendOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchFamilyJourneys(token)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    loadWorldData()
      .then((w) => {
        if (!cancelled) setWorldData(w);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Flatten every family member's stops, tagged with their user + colour.
  const layers = useMemo(() => {
    if (!data) return [];
    return (data.members || [])
      .map((member) => {
        const color = userColor(member.color_hue ?? 200);
        const stops = (member.journeys || [])
          .flatMap((j) => (j.stops || []).map((s) => ({ ...s, journeyTitle: j.title })))
          .filter((s) => s.lat != null && s.lng != null);
        return { member, color, stops: chronologicalSort(stops) };
      })
      .filter((m) => m.stops.length > 0);
  }, [data]);

  // Whole-world country shading (visited = any family stop in that country).
  const worldCountries = useMemo(() => {
    if (!worldData || !Array.isArray(worldData.features)) return [];
    const visitedSet = new Set(
      layers.flatMap((m) => m.stops.map((s) => s.country_name).filter(Boolean)),
    );
    return worldData.features.flatMap((f) => {
      const name = (f.properties || {}).name || (f.properties || {}).NAME || "";
      if (!name || name === "Antarctica") return [];
      const rings = geoToLatLngs(f.geometry).flatMap(splitRing);
      if (!rings.length) return [];
      const visited = [...visitedSet].some((c) => countryMatches(name, c));
      return [{ name, visited, rings }];
    });
  }, [worldData, layers]);

  const allStops = useMemo(
    () => layers.flatMap((m) => m.stops),
    [layers],
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-slate-400">Loading family journeys…</p>
      </div>
    );
  }

  if (!data.family) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-slate-500">
          You are not part of a family yet — ask your administrator to add you.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <MapContainer center={START_CENTER} zoom={START_ZOOM} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
        />

        {/* World shading */}
        <Pane name="world" style={{ zIndex: 250 }}>
          {worldCountries.map(({ name, visited, rings }) => {
            const { fill, stroke } = worldColors(name, visited);
            return rings.map((latlngs, i) => (
              <Polygon
                key={`world-${name}-${i}`}
                positions={latlngs}
                pathOptions={{
                  color: stroke,
                  fillColor: fill,
                  fillOpacity: 0.55,
                  weight: visited ? 1.6 : 0.7,
                  opacity: 0.9,
                  renderer: canvasRenderer,
                }}
              />
            ));
          })}
        </Pane>

        {/* Per-user layers: state fills → route line → pins */}
        {layers.map(({ member, color, stops }) => (
          <div key={member.id} className="family-layer">
            {/* State fills in the user's colour */}
            {stops.map((s) => {
              const rings = geoToLatLngs(s.state_geojson || s.geojson);
              if (!rings.length) return null;
              const fill = `${color}`.replace("48%", "72%").replace("hsl(", "hsl(");
              return rings.map((latlngs, i) => (
                <Polygon
                  key={`${member.id}-state-${s.order}-${i}`}
                  positions={latlngs}
                  pathOptions={{
                    color: userColor(member.color_hue ?? 200, "stroke"),
                    fillColor: userColor(member.color_hue ?? 200, "fill"),
                    fillOpacity: 0.55,
                    weight: 1.5,
                    opacity: 0.9,
                    renderer: canvasRenderer,
                  }}
                />
              ));
            })}
            {/* Route line */}
            {stops.length > 1 && (
              <Polyline
                positions={stops.map((s) => [s.lat, s.lng])}
                pathOptions={{ color, weight: 3, opacity: 0.9 }}
              />
            )}
            {/* Pins */}
            {stops.map((s) => (
              <Marker
                key={`${member.id}-${s.order}-${s.lat}-${s.lng}`}
                position={[s.lat, s.lng]}
                icon={userPin(s.order, color)}
              >
                <Tooltip direction="top" offset={[0, -34]} opacity={0.95} className="tj-tip">
                  <span className="text-xs font-medium">
                    {member.display_name} · {s.location}
                  </span>
                </Tooltip>
                <Popup>
                  <div className="min-w-[150px] text-xs">
                    <div className="font-bold">{s.location}</div>
                    {s.exact_location && s.exact_location !== s.location && (
                      <div className="mt-0.5 text-[10px] text-slate-400">{s.exact_location}</div>
                    )}
                    <div className="mt-0.5 text-[10px] font-medium" style={{ color }}>
                      {member.display_name}
                      {s.journeyTitle ? ` · ${s.journeyTitle}` : ""}
                    </div>
                    {(s.start_date || s.end_date) && (
                      <div className="mt-0.5 text-slate-600">
                        {s.start_date || "?"}
                        {s.end_date && s.end_date !== s.start_date ? ` → ${s.end_date}` : ""}
                      </div>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </div>
        ))}
      </MapContainer>

      {/* Legend: who is which colour */}
      <div className="absolute bottom-3 right-3 z-[1000] w-48 overflow-hidden rounded-lg border border-slate-200 bg-white/95 shadow-lg">
        <button
          onClick={() => setLegendOpen((v) => !v)}
          className="flex w-full items-center justify-between px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
        >
          <span>👨‍👩‍👧 Family · {data.family?.name}</span>
          <span className="text-slate-400">{legendOpen ? "▾" : "▸"}</span>
        </button>
        {legendOpen && (
          <div className="max-h-44 overflow-y-auto border-t border-slate-100 px-2 py-1.5">
            {layers.length === 0 && (
              <p className="py-1 text-[11px] text-slate-400">No journeys on the map yet.</p>
            )}
            {(data.members || []).map((m) => {
              const count = layers.find((l) => l.member.id === m.id)?.stops.length ?? 0;
              return (
                <div key={m.id} className="flex items-center gap-1.5 py-[3px] text-[11px] text-slate-600">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: userColor(m.color_hue ?? 200) }}
                  />
                  <span className="truncate">{m.display_name}</span>
                  <span className="ml-auto text-[10px] text-slate-400">{count} stop{count === 1 ? "" : "s"}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {allStops.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-xl bg-white/90 px-5 py-4 text-center shadow">
            <div className="text-2xl">👨‍👩‍👧</div>
            <p className="mt-1 text-sm font-medium text-slate-600">No family journeys yet</p>
            <p className="text-xs text-slate-400">Family members' trips will appear here</p>
          </div>
        </div>
      )}
    </div>
  );
}
