"""Travel Journey Map — FastAPI backend.

Serves these endpoints:

    GET  /api/health            — service + local LLM reachability status
    POST /api/auth/login        — username/password → JWT
    GET  /api/auth/me           — current user profile
    POST /api/admin/...         — admin: create/manage users & families
    POST /api/parse-itinerary   — PDF / XLSX / CSV upload or raw text → ordered stops
    POST /api/geocode           — batch geocode location strings (SQLite-cached)
    POST /api/search-location   — search candidates with coordinates (manual map fixes)

Designed to run on modest hardware alongside a local Ollama / LM Studio instance.
"""

from __future__ import annotations

import json
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import date
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from auth_routes import router as auth_router
from journey_routes import router as journey_router
from extraction_provider import (
    EXTRACTION_MODEL,
    OLLAMA_VISION_MODEL,
    VISION_MODEL,
    query_ollama_vision,
    query_omniroute_text,
    query_omniroute_vision,
)
from ocr import extract_image_text
from db import init_db
from models import User
from security import hash_password
from geocoder import Geocoder
from parsers import (
    _year_is_sane,
    classify_category,
    extract_content,
    feasibility_check,
    heuristic_parse,
)

log = logging.getLogger("uvicorn.error")

# ---------------------------------------------------------------------------
# Configuration — all overridable via environment variables.
# ---------------------------------------------------------------------------
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://localhost:11434").rstrip("/")
LLM_MODEL = os.environ.get("LLM_MODEL", "llama3.2")
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "120"))
GEOCODE_DELAY = float(os.environ.get("GEOCODE_DELAY", "1.0"))

# Admin bootstrap — override in production via env vars.
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
ADMIN_DISPLAY_NAME = os.environ.get("ADMIN_DISPLAY_NAME", "Administrator")


def _seed_admin() -> None:
    """Create the admin user on first startup (idempotent)."""
    from db import SessionLocal

    with SessionLocal() as db:
        if db.query(User).filter(User.role == "admin").first() is None:
            db.add(
                User(
                    username=ADMIN_USERNAME,
                    display_name=ADMIN_DISPLAY_NAME,
                    password_hash=hash_password(ADMIN_PASSWORD),
                    role="admin",
                )
            )
            db.commit()
            log.warning(
                "Seeded admin user %r — change ADMIN_PASSWORD before any real use.",
                ADMIN_USERNAME,
            )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    _seed_admin()
    yield


app = FastAPI(title="Travel Journey Map API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local single-user tool; restrict before deploying
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(journey_router)

geocoder = Geocoder(delay=GEOCODE_DELAY)


# ---------------------------------------------------------------------------
# Local LLM integration (Ollama native API, with OpenAI-compatible fallback).
# ---------------------------------------------------------------------------
LLM_PROMPT = """\
You are a precise travel-itinerary parser. The text below may be messy: it can \
contain flights, hotels, activities, timetables, or handwritten-style notes. \
Extract the sequence of VISITED LOCATIONS (cities, attractions, regions).

Today's date is {TODAY} — use it to classify each stop's status.

Return a JSON array. Each element is an object with exactly these keys:
- "order": integer, 1-based position in the journey
- "location": the short place name, e.g. "Paris" or "Eiffel Tower"
- "exact_location": the full context-aware place name including city, \
state/region, and country, e.g. "Hamilton, Waikato, New Zealand" instead of \
just "Hamilton"
- "start_date": ISO date (YYYY-MM-DD) when the visit began, otherwise ""
- "end_date": ISO date (YYYY-MM-DD) when the visit ended (same as start_date \
for a single day), otherwise ""
- "category": "Past", "Current", or "Upcoming" — compare the stop's dates to \
today's date ({TODAY})
- "notes": a short summary (max ~200 chars) of what happened there, otherwise ""
- "confirmed": true when you are confident this is a real visited stop; false \
when uncertain (e.g. it might be pure transit, a hotel, or the place name is \
unclear from the messy input).

Rules:
1. Keep the chronological order of the journey.
2. If one line lists several places (e.g. "Day 3: London -> Cambridge -> York"), \
create one entry per place, preserving order and the date.
3. If a date range covers several stops, apply that date to all of them.
4. Only include actual visited destinations; skip pure transit/connection flights \
unless they are a stop.
5. If the text contains no locations, return [].
6. Only output JSON — no markdown fences, no explanations, no extra keys.

Contextual awareness (IMPORTANT):
- Infer missing countries/regions based on surrounding itinerary stops. Do not \
jump across continents instantaneously unless explicit flight/transit details \
are present. Disambiguate ambiguous cities (e.g., Hamilton, Portland, \
Melbourne) by grounding them to the overall journey region.
- "exact_location" must always include enough context (city, state/region, \
country) to geocode unambiguously.

IMPORTANT: Return ONE array element per visited location. If the itinerary has N \
distinct stops, the array MUST have exactly N elements. Do not stop early.

Itinerary text:
<<<ITINERARY>>>
"""


def _build_prompt(text: str) -> str:
    today = date.today().isoformat()
    return (
        LLM_PROMPT.replace("{TODAY}", today)
        .replace("<<<ITINERARY>>>", text[:12000])
    )


def _parse_llm_json(content: str) -> list[dict[str, Any]]:
    """Extract a JSON array from an LLM response (tolerates code fences).

    Some models return a single object, or an object wrapping the array
    (e.g. {"stops": [...]}) — all of those are normalised to a list here.
    """
    content = content.strip()
    content = re.sub(r"^```(?:json)?\s*", "", content, flags=re.I)
    content = re.sub(r"\s*```$", "", content)

    def _load(s: str) -> Any:
        return json.loads(s)

    # Prefer an explicit array.
    start, end = content.find("["), content.rfind("]")
    if start != -1 and end > start:
        data = _load(content[start : end + 1])
        if isinstance(data, list):
            return data

    # Fall back to any top-level JSON value.
    try:
        data = _load(content)
    except json.JSONDecodeError:
        start, end = content.find("{"), content.rfind("}")
        if start == -1 or end <= start:
            raise ValueError("LLM response contained no JSON array") from None
        data = _load(content[start : end + 1])

    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("stops", "locations", "places"):
            if isinstance(data.get(key), list):
                return data[key]
        if data.get("location") or data.get("name"):
            return [data]  # a single stop object
    raise ValueError("LLM response was not a JSON array")


async def _query_llm(text: str, model: str | None = None) -> list[dict[str, Any]]:
    """Ask the local LLM to structure the itinerary; raises on any failure."""
    prompt = _build_prompt(text)
    effective = model or LLM_MODEL

    if LLM_BASE_URL.endswith("/v1"):
        # OpenAI-compatible endpoint (LM Studio, Ollama's OpenAI shim, ...)
        url = f"{LLM_BASE_URL}/chat/completions"
        payload = {
            "model": effective,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.0,
            "max_tokens": 4096,
        }
    else:
        # Ollama native generate endpoint
        url = f"{LLM_BASE_URL}/api/generate"
        payload = {
            "model": effective,
            "prompt": prompt,
            "stream": False,
            # NOTE: not using format="json" — it causes some models
            # (qwen2.5-coder, gemma4) to emit only a single object.
            "num_predict": 4096,
            "options": {"temperature": 0.0},
        }

    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        response = await client.post(url, json=payload)
        response.raise_for_status()
        data = response.json()

    if LLM_BASE_URL.endswith("/v1"):
        content = data["choices"][0]["message"]["content"]
    else:
        content = data.get("response", "")

    return _parse_llm_json(content)


async def _fetch_models() -> list[str]:
    """Return the model names installed on the local LLM server.

    Empty list means the server is unreachable, responded with an error, or has
    no models — in all of those cases the LLM path is skipped and parsing falls
    back to the built-in heuristic parser instantly.
    """
    url = (
        f"{LLM_BASE_URL}/api/tags"
        if not LLM_BASE_URL.endswith("/v1")
        else f"{LLM_BASE_URL}/models"
    )
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(url)
        if response.status_code >= 400:
            return []
        data = response.json()
        if not isinstance(data, dict):
            return []
        return [
            m.get("name") or m.get("id")
            for m in data.get("models", [])
            if isinstance(m, dict)
        ]
    except Exception:
        return []


def _pick_model(available: list[str]) -> str | None:
    """Choose which installed model to query.

    Returns the configured ``LLM_MODEL`` when it is installed; otherwise falls
    back to the smallest available model (by parameter count) so the app stays
    fast on modest hardware. Returns ``None`` when nothing is usable.
    """
    if not available:
        return None
    if LLM_MODEL and LLM_MODEL in available:
        return LLM_MODEL

    def size(name: str) -> int:
        # Grab the first "<digits>b" token (e.g. "gemma4:e4b" → 4b → 40).
        m = re.search(r"(\d+(?:\.\d+)?)\s*b", name, re.I)
        return int(float(m.group(1)) * 10) if m else 999

    return min(available, key=size)


def _clean_iso(value: Any) -> str:
    """Trim any value to a bare ISO date (YYYY-MM-DD), or ``""``.

    Dates carrying an implausible year (typos like 2918 instead of 2018) are
    dropped entirely so they don't produce a nonsense "Upcoming" category.
    """
    if value is None:
        return ""
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", str(value).strip())
    if not m:
        return ""
    return m.group(1) if _year_is_sane(int(m.group(1)[:4])) else ""


def _normalize_stops(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate / shape raw stop dicts into the canonical schema."""
    stops: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        location = str(item.get("location") or item.get("name") or "").strip()
        exact = str(item.get("exact_location") or "").strip()
        if not location and not exact:
            continue

        start = _clean_iso(item.get("start_date") or item.get("start"))
        end = _clean_iso(item.get("end_date") or item.get("end"))
        legacy_date = _clean_iso(item.get("date"))
        if not start:
            start = legacy_date
        if not end:
            end = start if (item.get("start_date") or item.get("date")) else ""

        # Category is recomputed deterministically from the dates when they
        # exist; the LLM's category is only trusted when no dates were given.
        category = str(item.get("category") or "").strip()
        if start or end:
            category = classify_category(start, end)
        else:
            category = {
                "past": "Past",
                "current": "Current",
                "upcoming": "Upcoming",
            }.get(category.lower(), "")

        notes = str(item.get("notes") or item.get("note") or "").strip()[:500]
        lat, lng = item.get("lat"), item.get("lng")
        conf = item.get("confirmed", True)
        confirmed = (
            conf
            if isinstance(conf, bool)
            else str(conf).lower() not in ("false", "no", "0", "")
        )
        stops.append(
            {
                "order": len(stops) + 1,
                "location": (location or exact)[:200],
                "exact_location": (exact or location)[:300],
                "start_date": start,
                "end_date": end,
                "category": category,
                "notes": notes,
                "confirmed": confirmed,
                "lat": _clean_coord(lat),
                "lng": _clean_coord(lng),
            }
        )
    return stops


def _clean_coord(value: Any) -> float | None:
    try:
        f = float(value)
        return f if -180 <= f <= 180 else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "travel-journey-map",
        "llm": await _llm_info(),
    }


async def _llm_info() -> dict[str, Any]:
    """Cheap probe of the local LLM: reachability + installed model names."""
    available = await _fetch_models()
    resolved = _pick_model(available) if available else None
    return {
        "url": LLM_BASE_URL,
        "model": LLM_MODEL,
        "resolved_model": resolved,
        "reachable": bool(available),
        "available_models": available,
    }


async def _ai_extract_text(text: str) -> tuple[list[dict[str, Any]], str, str | None, bool]:
    """AI extraction from text: Omniroute → Ollama → heuristic.

    Returns ``(stops, provider, model, llm_used)``. ``provider`` is one of
    ``omniroute``, ``ollama``, or ``heuristic``.
    """
    prompt = _build_prompt(text)

    raw = await query_omniroute_text(prompt)
    if raw:
        try:
            stops = _normalize_stops(_parse_llm_json(raw))
            if stops:
                return stops, "omniroute", EXTRACTION_MODEL, True
        except Exception as exc:
            log.warning("Omniroute parse failed: %s", exc)

    available = await _fetch_models()
    model = _pick_model(available) if available else None
    if model:
        try:
            stops = _normalize_stops(await _query_llm(text, model=model))
            if stops:
                return stops, "ollama", model, True
        except Exception as exc:
            log.warning("LLM parse failed (%s): %r", exc, model)

    stops = _normalize_stops(heuristic_parse(text))
    return stops, "heuristic", None, bool(stops)


@app.post("/api/parse-itinerary")
async def parse_itinerary(
    file: UploadFile | None = File(default=None),
    text: str | None = Form(default=None),
) -> dict[str, Any]:
    if file is None and not (text or "").strip():
        raise HTTPException(
            status_code=400,
            detail="Provide a file (PDF / XLSX / CSV / TXT / DOCX / image) or raw itinerary text.",
        )

    if file is not None:
        data = await file.read()
        try:
            content = await run_in_threadpool(
                extract_content, file.filename or "upload.txt", data
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        content = {"source_type": "text", "text": (text or "").strip(), "structured": None}

    stops: list[dict[str, Any]] = []
    llm_used = False
    llm_model: str | None = None
    engine: str = "structured" if content.get("structured") else ""
    provider: str | None = None

    # 1. Structured fast-path (known table columns — no AI needed).
    if content.get("structured"):
        stops = _normalize_stops(content["structured"])
        engine = "structured"
        provider = "structured"

    # 2. Image: OCR first, then the normal text AI path.
    elif content.get("source_type") == "image":
        ocr_text = await run_in_threadpool(extract_image_text, data)
        if ocr_text.strip():
            stops, provider, llm_model, llm_used = await _ai_extract_text(ocr_text)
            if provider in ("omniroute", "ollama"):
                provider = f"ocr+{provider}"
            engine = "ai" if llm_used else "heuristic"
            content["text"] = ocr_text  # preview the OCR'd text

        if not stops:
            # OCR failed — try a vision model as a last resort.
            mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                    "webp": "image/webp", "gif": "image/gif", "bmp": "image/bmp",
                    "tiff": "image/tiff"}.get(
                (file.filename or "").split(".")[-1].lower(), "image/png"
            )
            raw = await query_omniroute_vision(data, mime)
            if raw:
                provider = "vision"
                llm_model = VISION_MODEL
            else:
                raw = await query_ollama_vision(data, mime)
                if raw:
                    provider = "vision"
                    llm_model = OLLAMA_VISION_MODEL
            if raw:
                try:
                    stops = _normalize_stops(_parse_llm_json(raw))
                    engine = "ai"
                    llm_used = True
                except Exception as exc:
                    log.warning("AI vision parse failed: %s", exc)

        if not stops:
            raise HTTPException(
                status_code=422,
                detail="Couldn't read the itinerary from the image (OCR found no text). "
                "Try a clearer screenshot or paste the text directly.",
            )

    # 3. Text / PDF / DOCX: the AI-first text path.
    else:
        stops, provider, llm_model, llm_used = await _ai_extract_text(content["text"])
        engine = "ai" if llm_used else "heuristic"

    if not stops:
        raise HTTPException(
            status_code=422,
            detail="No locations found in the provided itinerary.",
        )

    return {
        "source_type": content["source_type"],
        "text_preview": content["text"][:2000],
        "llm_used": llm_used,
        "llm_model": llm_model,
        "engine": engine,
        "provider": provider,
        "stops": stops,
    }


class GeocodeStop(BaseModel):
    """A single stop submitted for geocoding + feasibility checking."""

    order: int | None = None
    location: str = ""
    exact_location: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    lat: float | None = None
    lng: float | None = None


class GeocodeRequest(BaseModel):
    locations: list[str] | None = None
    location: str | None = None
    stops: list[GeocodeStop] | None = None


class SearchLocationRequest(BaseModel):
    """Query for the manual location-fix search box."""

    query: str
    limit: int = 8


@app.post("/api/search-location")
async def search_location(request: SearchLocationRequest) -> dict[str, Any]:
    query = request.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Provide a non-empty 'query'.")
    results = await run_in_threadpool(
        geocoder.search_locations, query, max(1, min(request.limit, 10))
    )
    return {"query": query, "results": results}


@app.post("/api/geocode")
async def geocode(request: GeocodeRequest) -> dict[str, Any]:
    if request.stops:
        return await _geocode_stops(request.stops)

    locations = request.locations or ([request.location] if request.location else None)
    if not locations:
        raise HTTPException(
            status_code=400,
            detail="Provide 'location' (single string) or 'locations' (array of strings).",
        )
    locations = [loc.strip() for loc in locations if loc and loc.strip()]
    if not locations:
        raise HTTPException(status_code=400, detail="Provide at least one non-empty location.")
    results = await run_in_threadpool(geocoder.geocode_many, locations)
    states: dict[str, dict[str, Any]] = {}
    countries: dict[str, dict[str, Any]] = {}
    for r in results:
        name = r.get("state_name")
        geo = r.get("state_geojson")
        if name and geo:
            states[name] = geo
        cname = r.get("country_name")
        cgeo = r.get("country_geojson")
        if cname and cgeo:
            countries[cname] = cgeo
    return {
        "results": results,
        "feasibility": [],
        "states": [{"name": n, "geojson": g} for n, g in states.items()],
        "countries": [{"name": n, "geojson": g} for n, g in countries.items()],
    }


async def _geocode_stops(stops: list[GeocodeStop]) -> dict[str, Any]:
    """Geocode a stop list, then run the travel-feasibility (velocity) check.

    Stops that already carry coordinates are skipped (no network cost). The
    remaining queries are deduplicated and resolved in one rate-limited pass.
    Stops whose implied travel speed exceeds realistic limits are flagged as
    ``is_ambiguous`` and given Nominatim candidate names for the disambiguation
    dropdown in the UI.
    """
    resolved: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    pending: list[tuple[int, str]] = []  # (index into `resolved`, query)
    states: dict[str, dict[str, Any]] = {}  # state name → boundary polygon (deduped)
    countries: dict[str, dict[str, Any]] = {}  # country name → boundary polygon (deduped)

    def _collect_states(result: dict[str, Any]) -> None:
        name = result.get("state_name")
        geo = result.get("state_geojson")
        if name and geo:
            states[name] = geo

    def _collect_countries(result: dict[str, Any]) -> None:
        name = result.get("country_name")
        geo = result.get("country_geojson")
        if name and geo:
            countries[name] = geo

    for i, s in enumerate(stops):
        order = s.order or i + 1
        exact = (s.exact_location or s.location).strip()
        resolved.append(
            {
                "order": order,
                "location": s.location,
                "exact_location": exact,
                "start_date": s.start_date,
                "end_date": s.end_date,
                "lat": s.lat,
                "lng": s.lng,
            }
        )
        if s.lat is not None and s.lng is not None:
            info = geocoder.cached_info(exact) if exact else None
            if info is None:
                # Cache miss or legacy row without state data — re-geocode
                # (cached server-side for coords, so it's one fast request).
                pending.append((i, exact))
                continue
            result = {
                "order": order, "lat": s.lat, "lng": s.lng,
                "found": True, "cached": True,
                "geojson": (info or {}).get("geojson"),
                "state_name": info.get("state_name"),
                "state_geojson": info.get("state_geojson"),
                "country_name": info.get("country_name"),
                "country_geojson": info.get("country_geojson"),
                "error": None,
            }
            _collect_states(result)
            _collect_countries(result)
            results.append(result)
            continue
        if not exact:
            results.append(
                {"order": order, "lat": None, "lng": None,
                 "found": False, "cached": False,
                 "geojson": None,
                 "error": "Empty location string."}
            )
            continue
        pending.append((i, exact))

    unique_queries = list(dict.fromkeys(q for _, q in pending))
    if unique_queries:
        geo = await run_in_threadpool(geocoder.geocode_many, unique_queries)
        by_query = {r["location"]: r for r in geo}
        for i, query in pending:
            stop = resolved[i]
            r = by_query.get(query)
            if r is None:
                results.append(
                    {"order": stop["order"], "lat": None, "lng": None,
                     "found": False, "cached": False,
                     "geojson": None,
                     "error": "No geocode result."}
                )
                continue
            stop["lat"], stop["lng"] = r["lat"], r["lng"]
            result = {
                "order": stop["order"],
                "lat": r["lat"],
                "lng": r["lng"],
                "found": r["found"],
                "cached": r["cached"],
                "geojson": r.get("geojson"),
                "state_name": r.get("state_name"),
                "state_geojson": r.get("state_geojson"),
                "country_name": r.get("country_name"),
                "country_geojson": r.get("country_geojson"),
                "error": r["error"],
            }
            _collect_states(result)
            _collect_countries(result)
            results.append(result)

    feasibility = feasibility_check(resolved)

    # Fetch country/region candidates for the disambiguation dropdowns.
    flagged = [f for f in feasibility if f["is_ambiguous"]]
    if flagged:
        def _search(entry: dict[str, Any]) -> tuple[int, list[str]]:
            query = (entry["location"] or entry["exact_location"] or "").strip()
            return entry["order"], geocoder.search_candidates(query) if query else []

        pairs = await run_in_threadpool(lambda: [_search(f) for f in flagged])
        by_order = dict(pairs)
        for entry in feasibility:
            if entry["order"] in by_order:
                entry["candidates"] = by_order[entry["order"]]

    return {
        "results": results,
        "feasibility": feasibility,
        "states": [{"name": n, "geojson": g} for n, g in states.items()],
        "countries": [{"name": n, "geojson": g} for n, g in countries.items()],
    }