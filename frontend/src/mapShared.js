// Shared Leaflet helpers used by MapView (single-journey editor) and
// FamilyMap (multi-user family overlay).

import L from "leaflet";

export const START_CENTER = [20, 10];
export const START_ZOOM = 2;

// Deterministic golden-angle hue (0-359) for a name.
export function hashHue(key) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return ((h % 360) * 137.508) % 360;
}

// Vivid state fills (single-journey editor).
export function areaColors(key) {
  const hue = hashHue(key);
  return {
    fill: `hsl(${hue}, 72%, 55%)`,
    stroke: `hsl(${hue}, 55%, 30%)`,
  };
}

// Light pastel per country (visited-country emphasis).
export function countryColors(key) {
  const hue = hashHue(key);
  return {
    fill: `hsl(${hue}, 55%, 78%)`,
    stroke: `hsl(${hue}, 45%, 64%)`,
  };
}

// Whole-world shading: every country light, visited deeper.
export function worldColors(key, visited) {
  const hue = hashHue(key);
  return visited
    ? {
        fill: `hsl(${hue}, 48%, 76%)`,
        stroke: `hsl(${hue}, 40%, 58%)`,
      }
    : {
        fill: `hsl(${hue}, 35%, 86%)`,
        stroke: `hsl(${hue}, 25%, 78%)`,
      };
}

// Per-user family colour (from the user's color_hue).
export function userColor(hue, style = "fill") {
  if (style === "stroke") return `hsl(${hue}, 60%, 32%)`;
  if (style === "soft") return `hsl(${hue}, 55%, 80%)`;
  return `hsl(${hue}, 65%, 48%)`;
}

// Convert a GeoJSON geometry to Leaflet polygon rings ([lat,lng] pairs).
export function geoToLatLngs(geojson) {
  if (!geojson) return [];
  const flip = (ring) => ring.map(([lng, lat]) => [lat, lng]);
  if (geojson.type === "Polygon") return [flip(geojson.coordinates[0])];
  if (geojson.type === "MultiPolygon") {
    return geojson.coordinates.map((poly) => flip(poly[0]));
  }
  return [];
}

// LatLngBounds covering a polygon geometry, or null.
export function geoBounds(geojson) {
  const rings = geoToLatLngs(geojson);
  if (!rings.length) return null;
  return L.latLngBounds(rings.flat());
}

// Split a ring at antimeridian jumps (|Δlng| > 180°) so polygons like Russia
// don't get drawn as a straight line across the whole map.
export function splitRing(ring) {
  const parts = [];
  let cur = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (cur.length && Math.abs(p[1] - cur[cur.length - 1][1]) > 180) {
      parts.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

// Strictly chronological order: undated stops sort last (stable by order).
export function chronologicalSort(list) {
  return [...list].sort((a, b) => {
    const da = a.start_date || "9999-12-31";
    const db = b.start_date || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

// Shared canvas renderer keeps hundreds of polygon vertices light on
// low-end hardware (no SVG DOM nodes per city).
export const canvasRenderer = L.canvas({ padding: 0.5 });

// Module-level cache so the world dataset is fetched once per page load.
let worldDataPromise = null;
export function loadWorldData() {
  if (!worldDataPromise) {
    worldDataPromise = fetch("/countries-110m.geojson")
      .then((r) => {
        if (!r.ok) throw new Error(`world data ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        worldDataPromise = null; // allow retry on next mount
        throw err;
      });
  }
  return worldDataPromise;
}

// Match a stop's country name against a world-feature country name.
export function countryMatches(worldName, stopCountry) {
  const a = (worldName || "").toLowerCase();
  const b = (stopCountry || "").toLowerCase();
  return a === b || (b && (a.includes(b) || b.includes(a)));
}
