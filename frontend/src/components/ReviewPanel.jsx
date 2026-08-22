import ItineraryTable from "./ItineraryTable";

function providerLabel(source) {
  if (!source) return null;
  const p = source.provider;
  if (p === "omniroute") return `Omniroute AI${source.llmModel ? ` (${source.llmModel})` : ""}`;
  if (p === "ollama") return `Local LLM${source.llmModel ? ` (${source.llmModel})` : ""}`;
  if (p === "structured") return "Structured table (no AI)";
  if (p === "heuristic") return "Heuristic parser";
  if (source.engine === "ai") return "AI extraction";
  return source.engine || null;
}

export default function ReviewPanel({
  source,
  stops,
  busy,
  onPlot,
  onBack,
  onUpdate,
  onAdd,
  onDelete,
  onMove,
  onFocus,
  onDisambiguate,
  onLocate,
}) {
  const uncertain = stops.filter((s) => s.confirmed === false).length;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col p-4 lg:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-slate-800">
            Review extracted itinerary
          </h1>
          <p className="text-xs text-slate-400">
            The AI read your file and prepared {stops.length} stop
            {stops.length === 1 ? "" : "s"} — edit, remove, or confirm below,
            then plot them on the map.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {source?.provider && (
            <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
              ✨ {providerLabel(source)}
            </span>
          )}
          {uncertain > 0 && (
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-700">
              ⚠ {uncertain} uncertain
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <ItineraryTable
          stops={stops}
          onUpdate={onUpdate}
          onAdd={onAdd}
          onDelete={onDelete}
          onMove={onMove}
          onFocus={onFocus}
          onDisambiguate={onDisambiguate}
          onLocate={onLocate}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          onClick={onBack}
          disabled={busy}
          className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          ← Discard
        </button>
        <button
          onClick={onPlot}
          disabled={busy || !stops.length}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? "Geocoding…" : "🗺️ Plot on map"}
        </button>
      </div>
    </div>
  );
}
