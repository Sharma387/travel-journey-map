import { Fragment, useRef, useState } from "react";
import { searchLocations } from "../api";

function parseCoord(value) {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const STATUS_STYLES = {
  Past: "bg-slate-200 text-slate-700",
  Current: "bg-emerald-100 text-emerald-700",
  Upcoming: "bg-blue-100 text-blue-700",
};

function AmbiguityBanner({ stop, onDisambiguate }) {
  const [custom, setCustom] = useState("");
  const current = stop.exact_location || stop.location;
  const candidates = (stop.candidates || []).filter((c) => c && c !== current);

  const submitCustom = (e) => {
    e.preventDefault();
    const v = custom.trim();
    if (v) onDisambiguate(stop.order, v);
    setCustom("");
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2">
        <span className="text-amber-600">⚠️</span>
        <div>
          <p className="text-amber-900">
            {stop.warning || "This stop looks ambiguous — please confirm the correct region."}
          </p>
          <p className="mt-0.5 text-xs text-amber-700">
            Choose the correct country/region for stop #{stop.order} before plotting:
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <select
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) onDisambiguate(stop.order, e.target.value);
          }}
          className="rounded border border-amber-300 bg-white px-2 py-1 text-xs text-slate-700"
        >
          <option value="" disabled>
            Keep: {current}
          </option>
          {candidates.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <form onSubmit={submitCustom} className="flex items-center gap-1">
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="or type full location…"
            className="w-52 rounded border border-amber-300 bg-white px-2 py-1 text-xs"
          />
          <button
            type="submit"
            className="rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
          >
            Set
          </button>
        </form>
      </div>
    </div>
  );
}

function LocationSearch({ onClose, onPick }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const seq = useRef(0); // guards against stale async responses

  const runSearch = async (e) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q || searching) return;
    const mySeq = ++seq.current;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const res = await searchLocations(q);
      if (mySeq !== seq.current) return;
      setResults(res.results || []);
    } catch (err) {
      if (mySeq !== seq.current) return;
      setError(err.message || String(err));
    } finally {
      if (mySeq === seq.current) setSearching(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <form onSubmit={runSearch} className="flex flex-1 items-center gap-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder="Search a place… e.g. Hamilton, Waikato, New Zealand"
            className="w-full rounded border border-blue-300 bg-white px-2 py-1.5 text-xs text-slate-700 focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="shrink-0 rounded bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {searching ? "…" : "Search"}
          </button>
        </form>
        <button
          type="button"
          onClick={onClose}
          title="Close search"
          className="shrink-0 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
        >
          ✕
        </button>
      </div>

      {error && <p className="text-xs text-red-600">Search failed: {error}</p>}
      {searching && <p className="text-xs text-slate-400">Searching…</p>}

      {results && (
        <ul className="max-h-44 divide-y divide-slate-100 overflow-auto rounded border border-slate-200 bg-white">
          {results.map((r, i) => (
            <li key={`${r.label}-${i}`}>
              <button
                type="button"
                onClick={() => onPick(r)}
                disabled={r.lat == null || r.lng == null}
                title={r.display_name || r.label}
                className="flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-blue-50 disabled:opacity-50"
              >
                <span className="truncate">{r.label || r.display_name}</span>
                <span className="shrink-0 font-mono text-[10px] text-slate-400">
                  {r.lat != null && r.lng != null
                    ? `${r.lat.toFixed(2)}, ${r.lng.toFixed(2)}`
                    : "not found"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {results && !results.length && (
        <p className="text-xs text-slate-500">
          No results for “{query}”. Try adding a country, e.g. “{query}, New
          Zealand”.
        </p>
      )}
    </div>
  );
}

export default function ItineraryTable({
  stops,
  onUpdate,
  onAdd,
  onDelete,
  onMove,
  onFocus,
  onDisambiguate,
  onLocate,
}) {
  const [searchOpen, setSearchOpen] = useState(null); // stop order with open search
  const [collapsed, setCollapsed] = useState(false); // hide the table body
  const [expanded, setExpanded] = useState(false); // fill the sidebar height

  if (!stops.length) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-400">
        No stops yet — upload an itinerary to get started.
      </div>
    );
  }

  const inputCls =
    "w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none";

  const pickLocation = (order, result) => {
    setSearchOpen(null);
    onLocate(order, {
      exact_location: result.label || result.display_name,
      lat: result.lat,
      lng: result.lng,
    });
  };

  return (
    <div
      className={`rounded-lg border border-slate-200 ${
        expanded && !collapsed ? "flex min-h-0 flex-col lg:flex-1" : ""
      }`}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title={collapsed ? "Expand stops" : "Collapse stops"}
            onClick={() => setCollapsed((v) => !v)}
            className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] leading-none text-slate-500 hover:bg-slate-50"
          >
            {collapsed ? "▸" : "▾"}
          </button>
          <h2 className="text-sm font-semibold">Itinerary stops</h2>
          {collapsed && <span className="text-[11px] text-slate-400">({stops.length})</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title={expanded ? "Restore default height" : "Expand to fill the sidebar"}
            onClick={() => setExpanded((v) => !v)}
            disabled={collapsed}
            className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] leading-none text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          >
            {expanded ? "⤡" : "⤢"}
          </button>
          <button
            onClick={onAdd}
            className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
          >
            + Add
          </button>
        </div>
      </div>
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="w-full px-3 py-2 text-left text-xs text-slate-400 hover:bg-slate-50"
        >
          {stops.length} stop{stops.length !== 1 && "s"} — click to expand
        </button>
      ) : (
        <div
          className={
            expanded
              ? "min-h-0 flex-1 overflow-auto max-h-[85vh] lg:max-h-none lg:h-full"
              : "max-h-[46vh] overflow-auto"
          }
        >
          <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-2 py-1.5">Order</th>
              <th className="px-2 py-1.5">Location</th>
              <th className="px-2 py-1.5">Start</th>
              <th className="px-2 py-1.5">End</th>
              <th className="px-2 py-1.5">Status</th>
              <th className="px-2 py-1.5">Notes</th>
              <th className="px-2 py-1.5">Lat</th>
              <th className="px-2 py-1.5">Lng</th>
              <th className="px-2 py-1.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {stops.map((stop, i) => (
              <Fragment key={stop.order}>
                {stop.is_ambiguous && (
                  <tr className="border-t border-amber-200 bg-amber-50">
                    <td colSpan={9} className="px-3 py-2">
                      <AmbiguityBanner stop={stop} onDisambiguate={onDisambiguate} />
                    </td>
                  </tr>
                )}
                <tr className="border-t border-slate-100 align-top">
                  {/* Order / reorder */}
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-0.5">
                      <button
                        title="Move up"
                        onClick={() => onMove(stop.order, -1)}
                        disabled={i === 0}
                        className="text-slate-400 hover:text-blue-600 disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <span className="w-4 text-center font-medium">{stop.order}</span>
                      <button
                        title="Move down"
                        onClick={() => onMove(stop.order, 1)}
                        disabled={i === stops.length - 1}
                        className="text-slate-400 hover:text-blue-600 disabled:opacity-30"
                      >
                        ↓
                      </button>
                    </div>
                  </td>

                  {/* Location */}
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1">
                      <input
                        value={stop.location}
                        onChange={(e) => onUpdate(stop.order, { location: e.target.value })}
                        placeholder="Location"
                        className={inputCls}
                      />
                      <button
                        type="button"
                        title="Search & fix this location"
                        onClick={() =>
                          setSearchOpen(searchOpen === stop.order ? null : stop.order)
                        }
                        className={`shrink-0 rounded border px-1.5 py-1 text-[11px] leading-none ${
                          searchOpen === stop.order
                            ? "border-blue-500 bg-blue-50 text-blue-600"
                            : "border-slate-200 bg-white text-slate-400 hover:border-blue-400 hover:text-blue-600"
                        }`}
                      >
                        🔍
                      </button>
                    </div>
                    {stop.exact_location && stop.exact_location !== stop.location && (
                      <div
                        className="mt-0.5 truncate text-[10px] text-slate-400"
                        title={stop.exact_location}
                      >
                        {stop.exact_location}
                      </div>
                    )}
                  </td>

                  {/* Start date */}
                  <td className="px-2 py-1">
                    <input
                      type="date"
                      value={stop.start_date || ""}
                      onChange={(e) => onUpdate(stop.order, { start_date: e.target.value })}
                      className={inputCls}
                    />
                  </td>

                  {/* End date */}
                  <td className="px-2 py-1">
                    <input
                      type="date"
                      value={stop.end_date || ""}
                      onChange={(e) => onUpdate(stop.order, { end_date: e.target.value })}
                      className={inputCls}
                    />
                  </td>

                  {/* Status */}
                  <td className="px-2 py-1">
                    {stop.category ? (
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          STATUS_STYLES[stop.category] || "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {stop.category}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>

                  {/* Notes */}
                  <td className="px-2 py-1">
                    <input
                      value={stop.notes}
                      onChange={(e) => onUpdate(stop.order, { notes: e.target.value })}
                      placeholder="Notes"
                      className={inputCls}
                    />
                  </td>

                  {/* Lat */}
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      step="any"
                      defaultValue={stop.lat ?? ""}
                      key={`lat-${stop.order}-${stop.lat ?? ""}`}
                      onBlur={(e) => onUpdate(stop.order, { lat: parseCoord(e.target.value) })}
                      placeholder="—"
                      className={inputCls}
                    />
                  </td>

                  {/* Lng */}
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      step="any"
                      defaultValue={stop.lng ?? ""}
                      key={`lng-${stop.order}-${stop.lng ?? ""}`}
                      onBlur={(e) => onUpdate(stop.order, { lng: parseCoord(e.target.value) })}
                      placeholder="—"
                      className={inputCls}
                    />
                  </td>

                  {/* Actions */}
                  <td className="px-2 py-1">
                    <div className="flex items-center justify-end gap-1">
                      {stop.lat == null && (
                        <span title={stop.geocodeError || "Not geocoded"} className="text-amber-500">
                          ⚠
                        </span>
                      )}
                      <button
                        title="Center map on this stop"
                        onClick={() => onFocus(stop.order)}
                        className="text-slate-400 hover:text-blue-600"
                      >
                        ◎
                      </button>
                      <button
                        title="Delete stop"
                        onClick={() => onDelete(stop.order)}
                        className="text-slate-400 hover:text-red-600"
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
                {searchOpen === stop.order && (
                  <tr className="border-t border-blue-100 bg-blue-50/60">
                    <td colSpan={9} className="px-3 py-2">
                      <LocationSearch
                        onClose={() => setSearchOpen(null)}
                        onPick={(result) => pickLocation(stop.order, result)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
