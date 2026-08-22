import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import UploadPanel from "./components/UploadPanel";
import ItineraryTable from "./components/ItineraryTable";
import MapView from "./components/MapView";
import ControlPanel from "./components/ControlPanel";
import LoginPage from "./components/LoginPage";
import JourneyLibrary from "./components/JourneyLibrary";
import AdminPage from "./components/AdminPage";
import {
  geocodeStops,
  parseItinerary,
  fetchJourneys,
  fetchJourney,
  createJourney,
  updateJourney,
  deleteJourney,
} from "./api";

const EMPTY_STATUS = { kind: "idle", message: "" };
// How many stops to geocode per HTTP request. Smaller batches mean the
// progress counter and map update more frequently (and nothing blocks on a
// single giant request when the backend is rate-limited by Nominatim).
const GEOCODE_BATCH = 10;

const SESSION_KEY = "travel-journey-map:session";

const todayIso = () => new Date().toISOString().slice(0, 10);

// Mirrors the backend's deterministic classification (parsers.classify_category).
function classifyCategory(start, end) {
  if (!start && !end) return "";
  const today = todayIso();
  if (end) {
    if (end < today) return "Past";
    if (start && start > today) return "Upcoming";
    return "Current";
  }
  if (start < today) return "Past";
  if (start > today) return "Upcoming";
  return "Current";
}

const renumber = (list) => list.map((s, i) => ({ ...s, order: i + 1 }));

// Strictly chronological: undated stops sort last (stable by order).
const sortChronologically = (list) =>
  [...list].sort((a, b) => {
    const da = a.start_date || "9999-12-31";
    const db = b.start_date || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });

// Merge one geocode response (results + feasibility) into a stop list,
// keyed by stop order. Stops not present in the response are left untouched.
function mergeGeo(list, geo) {
  const byOrder = new Map((geo.results || []).map((r) => [r.order, r]));
  const byFeas = new Map((geo.feasibility || []).map((f) => [f.order, f]));
  const states = new Map((geo.states || []).map((st) => [st.name, st.geojson]));
  const countries = new Map((geo.countries || []).map((c) => [c.name, c.geojson]));
  return list.map((s) => {
    let next = { ...s };
    const r = byOrder.get(s.order);
    if (r) {
      next = {
        ...next,
        lat: r.lat ?? next.lat,
        lng: r.lng ?? next.lng,
        geojson: r.geojson ?? next.geojson,
        state_name: r.state_name ?? next.state_name,
        state_geojson:
          (r.state_name != null ? states.get(r.state_name) : undefined) ?? next.state_geojson,
        country_name: r.country_name ?? next.country_name,
        country_geojson:
          (r.country_name != null ? countries.get(r.country_name) : undefined) ??
          next.country_geojson,
        geocodeError: r.found ? null : r.error || "Not found",
      };
    }
    const f = byFeas.get(s.order);
    if (f) {
      next = {
        ...next,
        is_ambiguous: f.is_ambiguous,
        warning: f.warning,
        candidates: f.candidates || [],
      };
    }
    return next;
  });
}

function isAbortError(err) {
  return (
    err?.name === "AbortError" ||
    err?.cause?.name === "AbortError" ||
    err?.message?.includes("aborted")
  );
}

const STORAGE_KEY = "travel-journey-map:v1";

// Load the last auto-saved itinerary (or null). Stored payload shape:
// { stops, source, showLines, showStates, savedAt, light? }
function loadSavedItinerary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.stops) || !data.stops.length) return null;
    return data;
  } catch {
    return null; // corrupt or unavailable storage — start fresh
  }
}

// Persist the current itinerary to localStorage. The quota is small (≈5 MB), so
// if the full payload (with boundary polygons) doesn't fit we retry: first
// dropping per-city polygons but keeping state + country polygons (the coloring
// is what matters), then as a last resort markers only (a reload re-fetches).
function saveItinerary(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return "full";
  } catch {
    try {
      const statesOnly = {
        ...payload,
        light: true,
        stops: payload.stops.map((s) => ({ ...s, geojson: null })),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(statesOnly));
      return "light";
    } catch {
      try {
        const minimal = {
          ...payload,
          light: true,
          stops: payload.stops.map((s) => ({
            ...s,
            geojson: null,
            state_geojson: null,
            country_geojson: null,
          })),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(minimal));
        return "minimal";
      } catch {
        return "failed";
      }
    }
  }
}

export default function App() {
  // Session (login) — stored in localStorage so a refresh doesn't log out.
  const [session, setSession] = useState(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [page, setPage] = useState("library");
  const [journeys, setJourneys] = useState([]);
  const [journeyId, setJourneyId] = useState(null);
  const [journeyTitle, setJourneyTitle] = useState("");
  const [saving, setSaving] = useState(false);

  // Restore the last auto-saved itinerary draft once (only when logged out —
  // when logged in the DB is the source of truth for saved journeys).
  const savedRef = useRef(null);
  if (savedRef.current === null) savedRef.current = session ? null : loadSavedItinerary();
  const saved = savedRef.current;

  const [stops, setStops] = useState(saved?.stops ?? []);
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [source, setSource] = useState(saved?.source ?? null);
  const [showLines, setShowLines] = useState(saved?.showLines ?? true);
  const [showStates, setShowStates] = useState(saved?.showStates ?? saved?.showCities ?? true);
  const [showCountries, setShowCountries] = useState(saved?.showCountries ?? true);
  const [flySignal, setFlySignal] = useState(0);
  const [focus, setFocus] = useState({ order: null, stamp: 0 });
  const [health, setHealth] = useState(null);
  const [view, setView] = useState("all");
  const cancelRef = useRef(null); // AbortController for the current parse/geocode run
  const runSeq = useRef(0); // guards against stale async completions
  const repairedRef = useRef(false); // one-shot state-boundary repair on load

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  // Announce a restored itinerary once (not on every re-render).
  useEffect(() => {
    if (!saved) return;
    const n = saved.stops.length;
    setStatus({
      kind: "ready",
      message: `Restored ${n} saved stop${n === 1 ? "" : "s"} from this browser${
        saved.light ? " (some polygons not saved — storage limit)" : ""
      }.`,
    });
  }, [saved]);

  // Auto-save (debounced): every stops/source/toggle change is persisted to
  // localStorage so a refresh restores the full working session. Debounced
  // because the table fires onUpdate on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!stops.length && !source) return; // nothing meaningful to persist
      saveItinerary({ stops, source, showLines, showStates, showCountries, savedAt: Date.now() });
    }, 600);
    return () => clearTimeout(t);
  }, [stops, source, showLines, showStates, showCountries]);

  // Flush the latest state synchronously on tab close, so edits made within the
  // debounce window aren't lost.
  const latestRef = useRef(null);
  latestRef.current = { stops, source, showLines, showStates, showCountries };
  useEffect(() => {
    const flush = () => {
      const { stops, source, showLines, showStates, showCountries } = latestRef.current;
      if (!stops.length && !source) return;
      saveItinerary({ stops, source, showLines, showStates, showCountries, savedAt: Date.now() });
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  const clearSaved = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setStops([]);
    setSource(null);
    setView("all");
    setFlySignal((n) => n + 1);
    setStatus({
      kind: "ready",
      message: "Map cleared — upload or paste an itinerary to start fresh.",
    });
  }, []);

  // Log out and go back to the login screen.
  const logout = useCallback(() => {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {}
    setSession(null);
    setJourneyId(null);
    setJourneyTitle("");
  }, []);

  const handleLogin = useCallback((res) => {
    const payload = { token: res.access_token, user: res.user };
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {}
    setSession(payload);
  }, []);

  const handleNewJourney = useCallback(() => {
    setStops([]);
    setSource(null);
    setJourneyId(null);
    setJourneyTitle("");
    setView("all");
    setPage("map");
    setFlySignal((n) => n + 1);
  }, []);

  const handleOpenJourney = useCallback(
    async (id) => {
      try {
        const j = await fetchJourney(id, session.token);
        setStops(j.stops || []);
        setSource({
          type: j.source_type || null,
          engine: j.engine || null,
          llmUsed: j.llm_used,
          llmModel: j.llm_model || null,
        });
        setJourneyId(j.id);
        setJourneyTitle(j.title || "");
        setPage("map");
        setFlySignal((n) => n + 1);
        setStatus({ kind: "ready", message: `Loaded journey “${j.title}”.` });
      } catch (err) {
        setStatus({ kind: "error", message: err.message || String(err) });
      }
    },
    [session?.token],
  );

  const handleDeleteJourney = useCallback(
    async (id) => {
      try {
        await deleteJourney(id, session.token);
        setJourneys((prev) => prev.filter((j) => j.id !== id));
        if (journeyId === id) {
          setJourneyId(null);
          setJourneyTitle("");
          setStops([]);
          setSource(null);
        }
      } catch (err) {
        setStatus({ kind: "error", message: err.message || String(err) });
      }
    },
    [session?.token, journeyId],
  );

  const handleSaveJourney = useCallback(async () => {
    if (saving || !stops.length) return;
    setSaving(true);
    try {
      const payload = {
        title: journeyTitle || "My journey",
        source_type: source?.type ?? null,
        llm_used: !!source?.llmUsed,
        llm_model: source?.llmModel ?? null,
        engine: source?.engine ?? null,
        stops: stops.map((s) => ({
          order: s.order,
          location: s.location || "",
          exact_location: s.exact_location || "",
          start_date: s.start_date,
          end_date: s.end_date,
          category: s.category,
          notes: s.notes,
          lat: s.lat,
          lng: s.lng,
          geojson: s.geojson,
          state_name: s.state_name,
          state_geojson: s.state_geojson,
          country_name: s.country_name,
          country_geojson: s.country_geojson,
          is_ambiguous: s.is_ambiguous,
          warning: s.warning,
          candidates: s.candidates,
          note: s.note,
          geocode_error: s.geocode_error,
        })),
      };
      let result;
      if (journeyId) {
        result = await updateJourney(journeyId, payload, session.token);
      } else {
        result = await createJourney(payload, session.token);
        setJourneyId(result.id);
      }
      // Refresh the journey list.
      fetchJourneys(session.token).then(setJourneys).catch(() => {});
      setStatus({ kind: "ready", message: `Journey “${payload.title}” saved.` });
    } catch (err) {
      setStatus({ kind: "error", message: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  }, [stops, source, journeyId, journeyTitle, saving, session?.token]);

  const stopWork = useCallback(() => {
    cancelRef.current?.abort();
  }, []);
  // map/table fill in gradually instead of blocking on one huge request.
  // After all batches, one final request (with coords already cached) re-runs
  // the feasibility/velocity check over the WHOLE list for accurate flags.
  const applyGeocode = useCallback(
    async (list, { signal, onProgress, onBatch } = {}) => {
      if (!list.length) return list;
      const total = list.length;
      let mutable = list.map((s) => ({ ...s }));
      const pending = mutable.filter(
        (s) => s.lat == null || s.lng == null || !s.state_geojson || !s.country_geojson,
      );
      const done0 = total - pending.length;
      let done = done0;
      onProgress?.(done, total);

      for (let i = 0; i < pending.length; i += GEOCODE_BATCH) {
        if (signal?.aborted) break;
        const chunk = pending.slice(i, i + GEOCODE_BATCH);
        const geo = await geocodeStops(chunk, signal); // throws AbortError on cancel
        mutable = mergeGeo(mutable, geo);
        done += chunk.length;
        onProgress?.(done, total);
        onBatch?.([...mutable]);
      }

      if (signal?.aborted) return mutable;

      // Feasibility pass over the full journey — coords are already resolved,
      // so the backend does no network geocoding, only the velocity check.
      try {
        const geo = await geocodeStops(mutable, signal);
        mutable = mergeGeo(mutable, geo);
        onBatch?.([...mutable]);
      } catch (err) {
        if (!isAbortError(err)) {
          // Feasibility is best-effort; don't fail the whole flow for it.
        }
      }
      return mutable;
    },
    [],
  );

  const geoProgress = useCallback(
    (total) => (done, t) =>
      setStatus((st) =>
        st.kind === "geocoding"
          ? {
              ...st,
              message: `Geocoding ${done}/${t} stops…`,
              progress: { done, total: t },
            }
          : st,
      ),
    [],
  );

  async function handleParse(payload) {
    cancelRef.current?.abort();
    const controller = new AbortController();
    cancelRef.current = controller;
    const seq = ++runSeq.current;
    setStatus({ kind: "parsing", message: "Parsing itinerary…" });
    try {
      const res = await parseItinerary(payload, controller.signal);
      if (seq !== runSeq.current) return;
      setSource({
        type: res.source_type,
        llmUsed: res.llm_used,
        llmModel: res.llm_model || null,
        engine: res.engine || null,
        preview: res.text_preview,
      });
      const next = renumber(sortChronologically(res.stops));
      setStops(next);
      if (!next.length) {
        setStatus({ kind: "error", message: "No stops found in the itinerary." });
        return;
      }

      // Show the parsed table immediately, then geocode with live progress.
      setStatus({
        kind: "geocoding",
        message: "Geocoding stops…",
        progress: { done: 0, total: next.length },
      });
      const geocoded = await applyGeocode(next, {
        signal: controller.signal,
        onProgress: geoProgress(next.length),
        onBatch: setStops,
      });
      if (seq !== runSeq.current) return;
      setStops(geocoded);
      const located = geocoded.filter((s) => s.lat != null && s.lng != null).length;
      setStatus({
        kind: "ready",
        message: `Parsed ${geocoded.length} stop(s), ${located} geocoded${
          res.llm_used ? " via local LLM" : ""
        }.`,
      });
      setFlySignal((n) => n + 1);
    } catch (err) {
      if (isAbortError(err)) {
        setStatus({ kind: "ready", message: "Cancelled." });
      } else {
        setStatus({ kind: "error", message: err.message || String(err) });
      }
    } finally {
      if (seq === runSeq.current) cancelRef.current = null;
    }
  }

  async function handleRegeocode() {
    if (busy) return;
    cancelRef.current?.abort();
    const controller = new AbortController();
    cancelRef.current = controller;
    const seq = ++runSeq.current;
    setStatus({
      kind: "geocoding",
      message: "Geocoding stops…",
      progress: { done: 0, total: stops.length },
    });
    try {
      const geocoded = await applyGeocode(stops, {
        signal: controller.signal,
        onProgress: geoProgress(stops.length),
        onBatch: setStops,
      });
      if (seq !== runSeq.current) return;
      setStops(geocoded);
      const located = geocoded.filter((s) => s.lat != null && s.lng != null).length;
      setStatus({
        kind: "ready",
        message: `Geocoding finished — ${located} of ${geocoded.length} stops located.`,
      });
      setFlySignal((n) => n + 1);
    } catch (err) {
      if (isAbortError(err)) {
        setStatus({ kind: "ready", message: "Geocoding cancelled." });
      } else {
        setStatus({ kind: "error", message: err.message || String(err) });
      }
    } finally {
      if (seq === runSeq.current) cancelRef.current = null;
    }
  }

  // Fetch journey list on login.
  useEffect(() => {
    if (!session) return;
    fetchJourneys(session.token)
      .then(setJourneys)
      .catch(() => {});
  }, [session]);

  // Sessions restored from before the state/country coloring features (or
  // saved in "minimal" quota mode) lack state/country polygons, so the map
  // only shows tiny city fills until zoomed in. Re-fetch the boundaries once
  // on load — the backend is cached, so this only costs network on the first
  // visit — and the whole visited states/countries get colored right away.
  useEffect(() => {
    if (repairedRef.current) return;
    repairedRef.current = true;
    const restored = savedRef.current;
    if (!restored) return;
    const needsRepair = restored.stops.some(
      (s) =>
        s.lat != null &&
        s.lng != null &&
        (!s.state_geojson || !s.country_geojson),
    );
    if (!needsRepair) return;
    const controller = new AbortController();
    cancelRef.current = controller;
    const seq = ++runSeq.current;
    setStatus({
      kind: "geocoding",
      message: "Fetching boundaries for saved stops…",
      progress: { done: 0, total: restored.stops.length },
    });
    applyGeocode(restored.stops, {
      signal: controller.signal,
      onProgress: geoProgress(restored.stops.length),
      onBatch: setStops,
    })
      .then((next) => {
        if (seq !== runSeq.current) return;
        setStops(next);
        setStatus({
          kind: "ready",
          message: "Boundaries refreshed — visited states and countries are now colored on the map.",
        });
        setFlySignal((n) => n + 1);
      })
      .catch((err) => {
        if (seq !== runSeq.current) return;
        if (isAbortError(err)) {
          setStatus({ kind: "ready", message: "Boundary refresh cancelled." });
        } else {
          setStatus({ kind: "error", message: err.message || String(err) });
        }
      })
      .finally(() => {
        if (seq === runSeq.current) cancelRef.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Order-based editing — the timeline filter passes a subset to the table.
  const updateStop = (order, patch) => {
    setStops((prev) =>
      prev.map((s) => {
        if (s.order !== order) return s;
        let next = { ...s, ...patch };
        if (patch.location !== undefined) {
          // A location change invalidates geocoding + ambiguity state.
          next = {
            ...next,
            exact_location: patch.location,
            lat: null,
            lng: null,
            geojson: null,
            state_name: null,
            state_geojson: null,
            country_name: null,
            country_geojson: null,
            is_ambiguous: false,
            warning: null,
            candidates: [],
            geocodeError: null,
          };
        }
        if (patch.start_date !== undefined || patch.end_date !== undefined) {
          next.category = classifyCategory(next.start_date, next.end_date);
        }
        return next;
      }),
    );
  };

  const addStop = () =>
    setStops((prev) =>
      renumber([
        ...prev,
        {
          order: prev.length + 1,
          location: "",
          exact_location: "",
          start_date: "",
          end_date: "",
          category: "",
          notes: "",
          lat: null,
          lng: null,
          geojson: null,
          state_name: null,
          state_geojson: null,
          country_name: null,
          country_geojson: null,
          is_ambiguous: false,
          warning: null,
          candidates: [],
        },
      ]),
    );

  const deleteStop = (order) =>
    setStops((prev) => renumber(prev.filter((s) => s.order !== order)));

  const moveStop = (order, delta) =>
    setStops((prev) => {
      const idx = prev.findIndex((s) => s.order === order);
      const target = idx + delta;
      if (idx === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return renumber(next);
    });

  const focusStop = (order) => {
    if (order != null) setFocus({ order, stamp: Date.now() });
  };

  // User picked a different country/region for an ambiguous stop.
  const disambiguate = async (order, newExact) => {
    const updated = stops.map((s) =>
      s.order === order
        ? {
            ...s,
            exact_location: newExact,
            lat: null,
            lng: null,
            geojson: null,
            state_name: null,
            state_geojson: null,
            country_name: null,
            country_geojson: null,
            is_ambiguous: false,
            warning: null,
            candidates: [],
            geocodeError: null,
          }
        : s,
    );
    setStops(updated);
    setStatus({ kind: "geocoding", message: `Re-geocoding “${newExact}”…` });
    try {
      // Everything else is already cached, so this is fast; only the changed
      // stop hits the network.
      const next = await applyGeocode(updated, { onBatch: setStops });
      setStops(next);
      setStatus({ kind: "ready", message: `Re-geocoded as “${newExact}”.` });
    } catch (err) {
      setStatus({ kind: "error", message: err.message || String(err) });
    }
  };

  // User picked a result from the location search box — coords come straight
  // from the pick, so no network geocoding is needed; we only refresh the
  // feasibility/velocity flags over the whole journey (coords are cached).
  const locateStop = useCallback(
    async (order, pick) => {
      const exact = pick.exact_location || pick.label || pick.display_name || "";
      const updated = stops.map((s) =>
        s.order === order
          ? {
              ...s,
              exact_location: exact,
              lat: pick.lat,
              lng: pick.lng,
              geojson: pick.geojson ?? null,
              state_name: pick.state_name ?? null,
              state_geojson: pick.state_geojson ?? null,
              country_name: pick.country_name ?? null,
              country_geojson: pick.country_geojson ?? null,
              is_ambiguous: false,
              warning: null,
              candidates: [],
              geocodeError: null,
            }
          : s,
      );
      setStops(updated);
      setStatus({ kind: "geocoding", message: `Placing “${exact}”…` });
      try {
        const next = await applyGeocode(updated, { onBatch: setStops });
        setStops(next);
        setStatus({ kind: "ready", message: `Mapped to “${exact}”.` });
        setFlySignal((n) => n + 1);
        setFocus({ order, stamp: Date.now() });
      } catch (err) {
        setStatus({ kind: "error", message: err.message || String(err) });
      }
    },
    [stops, applyGeocode],
  );

  // Timeline filter state
  const years = useMemo(() => {
    const set = new Set();
    stops.forEach((s) => {
      const y = (s.start_date || "").slice(0, 4);
      if (/^\d{4}$/.test(y)) set.add(y);
    });
    return [...set].sort();
  }, [stops]);

  const visibleStops = useMemo(() => {
    if (view === "all") return stops;
    if (view === "past") return stops.filter((s) => s.category === "Past");
    if (view === "current") return stops.filter((s) => s.category === "Current");
    if (view === "upcoming") return stops.filter((s) => s.category === "Upcoming");
    if (view.startsWith("year-")) {
      const y = view.slice(5);
      return stops.filter((s) => (s.start_date || "").startsWith(y));
    }
    return stops;
  }, [stops, view]);

  const geocodedCount = stops.filter((s) => s.lat != null && s.lng != null).length;
  const flaggedCount = stops.filter((s) => s.is_ambiguous).length;
  const busy = status.kind === "parsing" || status.kind === "geocoding";

  if (!session) {
    return (
      <div className="flex h-full flex-col bg-slate-50">
        <LoginPage onLogin={handleLogin} />
      </div>
    );
  }

  const isAdmin = session.user?.role === "admin";

  return (
    <div className="flex h-full flex-col bg-slate-50 text-slate-800">
      {/* Header */}
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold tracking-tight lg:text-lg">🗺️ Travel Journey Map</h1>
        </div>
        <nav className="flex items-center gap-1 text-xs font-medium">
          <button
            onClick={() => setPage("library")}
            className={`rounded-md px-2.5 py-1.5 ${
              page === "library"
                ? "bg-blue-50 text-blue-700"
                : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            🧳 Journeys
          </button>
          <button
            onClick={() => setPage("map")}
            className={`rounded-md px-2.5 py-1.5 ${
              page === "map"
                ? "bg-blue-50 text-blue-700"
                : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            🗺️ Map
          </button>
          {isAdmin && (
            <button
              onClick={() => setPage("admin")}
              className={`rounded-md px-2.5 py-1.5 ${
                page === "admin"
                  ? "bg-purple-50 text-purple-700"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              👤 Admin
            </button>
          )}
        </nav>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="hidden sm:inline">
            👋 {session.user?.display_name}
          </span>
          {session.user?.role === "admin" && (
            <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
              admin
            </span>
          )}
          <button
            onClick={logout}
            className="rounded-md border border-slate-200 px-2 py-1 font-medium hover:bg-slate-50"
          >
            Log out
          </button>
        </div>
      </header>

      {page === "library" && (
        <JourneyLibrary
          journeys={journeys}
          onOpen={handleOpenJourney}
          onNew={handleNewJourney}
          onDelete={handleDeleteJourney}
          busy={busy}
        />
      )}

      {page === "admin" && isAdmin && <AdminPage token={session.token} />}

      {page === "map" && (
        <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Sidebar */}
          <aside className="flex w-full flex-col gap-4 overflow-y-auto border-b border-slate-200 bg-white p-4 lg:w-[460px] lg:border-b-0 lg:border-r">
            <UploadPanel onParse={handleParse} busy={busy} />
            <ControlPanel
              stops={stops}
              viewCount={visibleStops.length}
              source={source}
              showLines={showLines}
              onToggleLines={() => setShowLines((v) => !v)}
              showStates={showStates}
              onToggleStates={() => setShowStates((v) => !v)}
              showCountries={showCountries}
              onToggleCountries={() => setShowCountries((v) => !v)}
              onRecenter={() => setFlySignal((n) => n + 1)}
              onGeocode={handleRegeocode}
              flaggedCount={flaggedCount}
              busy={busy}
              view={view}
              onViewChange={setView}
              years={years}
              journeyTitle={journeyTitle}
              onJourneyTitleChange={setJourneyTitle}
              onSaveJourney={handleSaveJourney}
              saving={saving}
              onClear={clearSaved}
              onClearSaved={clearSaved}
            />
            <ItineraryTable
              stops={visibleStops}
              onUpdate={updateStop}
              onAdd={addStop}
              onDelete={deleteStop}
              onMove={moveStop}
              onFocus={focusStop}
              onDisambiguate={disambiguate}
              onLocate={locateStop}
            />
          </aside>

          {/* Map view */}
          <section className="relative min-h-[55vh] flex-1 lg:min-h-0">
            <MapView
              stops={visibleStops}
              showLines={showLines}
              showStates={showStates}
              showCountries={showCountries}
              flySignal={flySignal}
              focus={focus}
            />
            {status.kind !== "idle" && status.message && (
              <div
                className={`absolute left-1/2 top-3 z-[1200] w-[min(92%,440px)] -translate-x-1/2 rounded-lg px-3 py-2 text-xs font-medium shadow ${
                  status.kind === "error"
                    ? "bg-red-600 text-white"
                    : status.kind === "ready"
                      ? "bg-emerald-600 text-white"
                      : "bg-slate-900/85 text-white"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate">{status.message}</span>
                  {busy && (
                    <button
                      onClick={stopWork}
                      className="shrink-0 rounded bg-white/20 px-2 py-0.5 text-[10px] font-semibold hover:bg-white/35"
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {status.kind === "geocoding" && status.progress && (
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/25">
                    <div
                      className="h-full rounded-full bg-white transition-all duration-300"
                      style={{
                        width: `${
                          status.progress.total
                            ? Math.round((status.progress.done / status.progress.total) * 100)
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

function HealthBadge({ health }) {
  if (!health) return <span>backend: unknown</span>;
  const ok = health.status === "ok";
  const llm = health.llm || {};
  const llmLabel = llm.reachable
    ? `LLM online${llm.resolved_model ? ` (${llm.resolved_model})` : ""}`
    : "LLM offline";
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} />
      {ok ? `backend ok · ${llmLabel}` : "backend down"}
    </span>
  );
}
