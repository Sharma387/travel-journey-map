"""Geocoding with Nominatim (geopy) and a local SQLite cache.

Provides a rate-limited geocoder that caches both successful lookups and
"not found" results so repeated queries (e.g. after an app restart) are free.
"""

from __future__ import annotations

import json
import sqlite3
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from geopy.geocoders import Nominatim

DB_PATH = Path(__file__).resolve().parent / "geocoding_cache.db"
USER_AGENT = "travel-journey-map/1.0 (local personal app)"

# Order matters: the first present key becomes the place's name.
#
# POI / named-feature keys come first (the resort at Sun City, South
# Africa is class=leisure,type=resort with ``leisure: "Sun City"``, and
# its ``city`` is the larger municipality "Moses Kotane Local
# Municipality").  Populated places follow most-specific-first: OSM's
# ``city`` often holds the surrounding municipality while the actual
# settlement lives in ``town`` / ``village`` / ``hamlet``.
_LABEL_NAME_KEYS = (
    # Named features / POIs
    "attraction",
    "tourism",
    "museum",
    "hotel",
    "leisure",
    "amenity",
    "building",
    "historic",
    "man_made",
    "shop",
    "craft",
    "office",
    "place_of_worship",
    "aeroway",
    "railway",
    "peak",
    "volcano",
    "island",
    "natural",
    "water",
    "locality",
    "isolated_dwelling",
    # Populated places, most specific first
    "hamlet",
    "village",
    "town",
    "city",
    "municipality",
    "suburb",
    "county",
)
_LABEL_STATE_KEYS = ("state", "region", "county", "province")


def _short_label(place) -> str:
    """Build a compact "City, Region, Country" label from a geopy result.

    Nominatim's full ``display_name`` can be very long (house number,
    road, neighbourhood, ...).  For the exact_location field we want a
    concise, re-geocodable name like "Hamilton, Waikato, New Zealand".
    """
    addr = (place.raw or {}).get("address") or {}
    parts: list[str] = []
    for key in _LABEL_NAME_KEYS:
        if addr.get(key):
            parts.append(addr[key])
            break
    for key in _LABEL_STATE_KEYS:
        if addr.get(key):
            parts.append(addr[key])
            break
    if addr.get("country"):
        parts.append(addr["country"])

    # Fall back to the first segment of the full address (e.g. the POI name)
    # when no address part matched, so the label is still useful and short.
    if not parts and place.address:
        parts = [place.address.split(",")[0].strip()]

    # Join with case-insensitive dedup: a suburb named like the country (or a
    # duplicate region) would otherwise yield "South Africa, South Africa".
    seen: set[str] = set()
    joined: list[str] = []
    for p in parts:
        if p and p.lower() not in seen:
            seen.add(p.lower())
            joined.append(p)
    return ", ".join(joined) or (place.address or "")


def _normalize(location: str) -> str:
    """Canonical cache key: lowercase, single whitespace."""
    return " ".join(location.lower().split())


class Geocoder:
    """Rate-limited Nominatim geocoder with an on-disk SQLite cache.

    Parameters
    ----------
    delay : float
        Minimum seconds between successive Nominatim HTTP requests (default 1.0).
        This respects the Nominatim usage policy.  Set to 0 for testing.
    user_agent : str
        User-agent string sent to Nominatim.
    db_path : str | Path
        Path to the SQLite cache file.
    """

    def __init__(
        self,
        delay: float = 1.0,
        user_agent: str = USER_AGENT,
        db_path: str | Path = DB_PATH,
    ) -> None:
        self.delay = delay
        self.db_path = Path(db_path)
        self._geolocator = Nominatim(user_agent=user_agent, timeout=10)
        self._last_request = 0.0
        self._init_db()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS geocodes (
                    key         TEXT PRIMARY KEY,
                    location    TEXT NOT NULL,
                    lat         REAL,
                    lng         REAL,
                    display_name TEXT,
                    found       INTEGER NOT NULL DEFAULT 0,
                    queried_at  TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS candidates (
                    key         TEXT PRIMARY KEY,
                    names       TEXT NOT NULL,
                    queried_at  TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS searches (
                    key         TEXT PRIMARY KEY,
                    results     TEXT NOT NULL,
                    queried_at  TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )

            # Migration: add the geojson (city-boundary polygon) column to the
            # geocodes cache. Rows cached before this column existed have no
            # geometry, so drop them to force a one-time re-fetch with polygons.
            cols = {row[1] for row in conn.execute("PRAGMA table_info(geocodes)")}
            if "geojson" not in cols:
                conn.execute("ALTER TABLE geocodes ADD COLUMN geojson TEXT")
            if "state_name" not in cols:
                conn.execute("ALTER TABLE geocodes ADD COLUMN state_name TEXT")
            if "state_query" not in cols:
                conn.execute("ALTER TABLE geocodes ADD COLUMN state_query TEXT")
            if "country_name" not in cols:
                conn.execute("ALTER TABLE geocodes ADD COLUMN country_name TEXT")
            if "country_query" not in cols:
                conn.execute("ALTER TABLE geocodes ADD COLUMN country_query TEXT")
            conn.execute("DELETE FROM geocodes WHERE found = 1 AND geojson IS NULL")

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _cached(self, key: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT lat, lng, found, geojson, state_name, state_query, "
                "country_name, country_query FROM geocodes WHERE key = ?",
                (key,),
            ).fetchone()
        if row is None:
            return None
        geojson = None
        if row[3]:
            try:
                geojson = json.loads(row[3])
            except (TypeError, ValueError):
                geojson = None
        return {
            "lat": row[0], "lng": row[1], "found": bool(row[2]),
            "geojson": geojson, "state_name": row[4], "state_query": row[5],
            "country_name": row[6], "country_query": row[7],
        }

    def _store(
        self,
        key: str,
        location: str,
        lat: float | None,
        lng: float | None,
        display_name: str | None,
        found: bool,
        geojson: dict[str, Any] | None = None,
        state_name: str | None = None,
        state_query: str | None = None,
        country_name: str | None = None,
        country_query: str | None = None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO geocodes "
                "(key, location, lat, lng, display_name, found, geojson, state_name, state_query, country_name, country_query) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (key, location, lat, lng, display_name, int(found), json.dumps(geojson),
                 state_name, state_query, country_name, country_query),
            )

    def _wait_rate_limit(self) -> None:
        wait = self.delay - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.monotonic()

    def _state_info(self, cached):
        """(state_name, state_geojson) for a geocode row dict from _cached()."""
        state_name = cached.get("state_name")
        state_geojson = None
        state_query = cached.get("state_query")
        if state_query:
            sc = self._cached(_normalize(state_query))
            if sc is not None and sc["found"]:
                state_geojson = sc.get("geojson")
        return state_name, state_geojson

    def _resolve_state(self, state_query):
        """Fetch (and cache) a simplified state/region boundary polygon.

        Direct Nominatim search via urllib because geopy's geocode does not
        forward extra params like polygon_threshold. polygon_threshold keeps
        large state boundaries to hundreds of vertices.
        """
        return self._resolve_boundary(state_query, threshold=0.005)

    def _resolve_country(self, country_query):
        """Fetch (and cache) a simplified country boundary polygon.

        Countries are much larger than states, so a bigger polygon_threshold
        keeps even huge borders (USA, Russia, India) to a few hundred vertices.
        """
        return self._resolve_boundary(country_query, threshold=0.012)

    def _resolve_boundary(self, query: str, threshold: float):
        """Shared Nominatim boundary lookup with SQLite caching."""
        qkey = _normalize(query)
        cached = self._cached(qkey)
        if cached is not None:
            return cached.get("geojson") if cached["found"] else None
        self._wait_rate_limit()
        params = urllib.parse.urlencode({
            "q": query, "format": "jsonv2", "limit": 1,
            "polygon_geojson": 1, "polygon_threshold": threshold,
            "accept-language": "en",
        })
        url = f"https://nominatim.openstreetmap.org/search?{params}"
        req = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None
        if not data:
            self._store(qkey, query, None, None, None, False)
            return None
        # Prefer the first result that actually carries a polygon; Nominatim's
        # top hit for a country name can occasionally be a sub-division or a
        # point feature without geometry.
        chosen = next((r for r in data[:3] if r.get("geojson")), data[0])
        lat = float(chosen["lat"]) if chosen.get("lat") is not None else None
        lng = float(chosen["lon"]) if chosen.get("lon") is not None else None
        geojson = chosen.get("geojson")
        self._store(qkey, query, lat, lng, chosen.get("display_name"),
                    bool(geojson), geojson)
        return geojson

    def _country_info(self, cached):
        """(country_name, country_geojson) for a geocode row dict from _cached()."""
        country_name = cached.get("country_name")
        country_geojson = None
        country_query = cached.get("country_query")
        if country_query:
            cc = self._cached(_normalize(country_query))
            if cc is not None and cc["found"]:
                country_geojson = cc.get("geojson")
        return country_name, country_geojson

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def geocode(self, location: str) -> dict[str, Any]:
        """Geocode a single location string.

        Returns a dict with keys: ``location``, ``lat``, ``lng``, ``found``,
        ``cached``, ``geojson``, ``error``.
        """
        key = _normalize(location)
        cached = self._cached(key)
        if cached is not None and (cached.get("state_query") or not cached["found"]):
            # Legacy rows predating the country feature have country_query
            # as SQL NULL — treat as a miss so the fresh path backfills.
            if cached["found"] and cached.get("country_query") is None:
                pass  # fall through to the fresh path below
            else:
                state_name, state_geojson = self._state_info(cached)
                country_name, country_geojson = self._country_info(cached)
                return {
                    "location": location,
                    "lat": cached["lat"],
                    "lng": cached["lng"],
                    "found": cached["found"],
                    "cached": True,
                    "geojson": cached.get("geojson"),
                    "state_name": state_name,
                    "state_geojson": state_geojson,
                    "country_name": country_name,
                    "country_geojson": country_geojson,
                    "error": None if cached["found"] else "Not found (cached).",
                }

        self._wait_rate_limit()
        try:
            place = self._geolocator.geocode(
                location,
                language="en",
                limit=1,
                exactly_one=True,
                geometry="geojson",  # city-boundary polygon, same HTTP request
                addressdetails=True,  # needed for the state/region extraction
            )
        except Exception as exc:
            return {
                "location": location,
                "lat": None,
                "lng": None,
                "found": False,
                "cached": False,
                "geojson": None,
                "error": f"{type(exc).__name__}: {exc}",
            }

        if place is None:
            self._store(key, location, None, None, None, False)
            return {
                "location": location,
                "lat": None,
                "lng": None,
                "found": False,
                "cached": False,
                "geojson": None,
                "error": "Not found on Nominatim.",
            }

        geojson = (place.raw or {}).get("geojson")
        addr = (place.raw or {}).get("address") or {}
        # State/region boundary info. Precedence: state > region > province >
        # state_district (deliberately NOT county — county is sub-state).
        state_name = (
            addr.get("state") or addr.get("region")
            or addr.get("province") or addr.get("state_district")
        )
        country = addr.get("country") or ""
        if country:
            country_query = country
            country_geojson = self._resolve_country(country_query)
        else:
            country_query = ""  # sentinel: fetched but no country
            country_geojson = None
        state_query = (
            ", ".join(p for p in (state_name, country) if p) or None
        )
        state_geojson = self._resolve_state(state_query) if state_query else None
        self._store(key, location, place.latitude, place.longitude, place.address, True,
                    geojson, state_name=state_name, state_query=state_query,
                    country_name=country or None, country_query=country_query)
        return {
            "location": location,
            "lat": place.latitude,
            "lng": place.longitude,
            "found": True,
            "cached": False,
            "geojson": geojson,
            "state_name": state_name,
            "state_geojson": state_geojson,
            "country_name": country or None,
            "country_geojson": country_geojson,
            "error": None,
        }

    def cached_info(self, location: str) -> dict[str, Any] | None:
        """Return cached coords + polygon + state info for a location string, or ``None``.

        Returns ``None`` when the row is missing, not found, or is a legacy row
        that lacks ``state_query``.  The caller treats ``None`` as a cache miss
        and dispatches the stale stop through the normal re-geocode path, which
        backfills ``state_name`` / ``state_query`` / ``state_geojson``.
        """
        cached = self._cached(_normalize(location))
        if cached is None or (cached["found"] and cached.get("country_query") is None):
            return None  # missing, not found, or legacy row without country data
        state_name, state_geojson = self._state_info(cached)
        country_name, country_geojson = self._country_info(cached)
        return {
            "lat": cached["lat"], "lng": cached["lng"], "found": cached["found"],
            "geojson": cached.get("geojson"),
            "state_name": state_name, "state_geojson": state_geojson,
            "country_name": country_name, "country_geojson": country_geojson,
        }

    def geocode_many(self, locations: list[str]) -> list[dict[str, Any]]:
        """Geocode a list of location strings, respecting rate limits."""
        return [self.geocode(loc) for loc in locations]

    # ------------------------------------------------------------------
    # Disambiguation candidates
    # ------------------------------------------------------------------
    def _cached_candidates(self, key: str) -> list[str] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT names FROM candidates WHERE key = ?", (key,)
            ).fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def _store_candidates(self, key: str, names: list[str]) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO candidates (key, names) VALUES (?, ?)",
                (key, json.dumps(names)),
            )

    def search_candidates(self, query: str, limit: int = 6) -> list[str]:
        """Return candidate place-name strings for disambiguation.

        Checks the local cache first, then queries Nominatim with
        ``exactly_one=False``.  Each candidate is a short label like
        "Hamilton, Waikato, New Zealand" (first address part + last two
        parts) to help the user pick the right region.
        """
        key = _normalize(query)
        cached = self._cached_candidates(key)
        if cached is not None:
            return cached

        self._wait_rate_limit()
        try:
            places = self._geolocator.geocode(
                query, language="en", limit=limit, exactly_one=False
            )
        except Exception:
            return [query]

        if not places:
            self._store_candidates(key, [query])
            return [query]

        names: list[str] = []
        seen: set[str] = set()
        for place in places:
            parts = [p.strip() for p in place.address.split(",")]
            # label = first part + last 2 parts (city, state, country)
            label = ", ".join(
                p for p in [parts[0]] + parts[-2:] if p
            )
            if label.lower() not in seen:
                seen.add(label.lower())
                names.append(label)

        if not names:
            names = [query]

        self._store_candidates(key, names)
        return names

    # ------------------------------------------------------------------
    # Location search (user-initiated fixes)
    # ------------------------------------------------------------------
    def _cached_search_results(self, key: str) -> list[dict[str, Any]] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT results FROM searches WHERE key = ?", (key,)
            ).fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def _store_search_results(self, key: str, results: list[dict[str, Any]]) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO searches (key, results) VALUES (?, ?)",
                (key, json.dumps(results)),
            )

    def search_locations(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        """Return search results for a location query, for the manual-fix UI.

        Each result has a short ``label`` (e.g. "Hamilton, Waikato, New
        Zealand"), the resolved coordinates, and the full Nominatim
        ``display_name``.  Results are cached in SQLite so repeat searches are
        free and rate-limited like every other Nominatim request.
        """
        key = _normalize(query)
        cached = self._cached_search_results(key)
        if cached is not None:
            return cached

        self._wait_rate_limit()
        try:
            places = self._geolocator.geocode(
                query, language="en", limit=limit, exactly_one=False,
                addressdetails=True, geometry="geojson",
            )
        except Exception as exc:
            return [
                {
                    "label": query,
                    "display_name": query,
                    "lat": None,
                    "lng": None,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            ]

        results: list[dict[str, Any]] = []
        for place in places or []:
            addr = (place.raw or {}).get("address") or {}
            state_name = (
                addr.get("state") or addr.get("region")
                or addr.get("province") or addr.get("state_district")
            )
            results.append(
                {
                    "label": _short_label(place),
                    "display_name": place.address,
                    "lat": place.latitude,
                    "lng": place.longitude,
                    "geojson": (place.raw or {}).get("geojson"),
                    "state_name": state_name,
                    "country_name": addr.get("country") or None,
                }
            )
        if not results:
            results = [
                {"label": query, "display_name": query, "lat": None, "lng": None}
            ]

        self._store_search_results(key, results)
        return results