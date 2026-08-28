import { useEffect, useState } from "react";
import MapView from "./MapView";
import { fetchPublicJourney } from "../api";

export default function SharedJourneyView({ shareToken }) {
  const [journey, setJourney] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchPublicJourney(shareToken)
      .then((j) => {
        if (!cancelled) setJourney(j);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [shareToken]);

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-lg">🗺️</span>
          <div className="leading-tight">
            <h1 className="text-sm font-bold tracking-tight text-slate-800">
              {journey?.title || "Shared journey"}
            </h1>
            {journey?.owner_name && (
              <p className="text-[11px] text-slate-400">
                Shared by {journey.owner_name}
              </p>
            )}
          </div>
        </div>
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
          🔒 Read-only view
        </span>
      </header>

      <main className="min-h-0 flex-1">
        {error ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="rounded-xl border border-slate-200 bg-white px-6 py-8 text-center shadow-sm">
              <div className="text-3xl">🔗</div>
              <p className="mt-2 text-sm font-medium text-slate-700">
                Journey not found
              </p>
              <p className="mt-1 text-xs text-slate-400">{error}</p>
              <p className="mt-3 text-xs text-slate-400">
                The share link may have expired or been removed by its owner.
              </p>
            </div>
          </div>
        ) : !journey ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-slate-400">Loading shared journey…</p>
          </div>
        ) : (
          <MapView
            stops={journey.stops || []}
            showLines
            showStates
            showCountries
            flySignal={1}
            focus={{ order: null, stamp: 0 }}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white px-4 py-1.5 text-center text-[11px] text-slate-400">
        🗺️ Powered by Travel Journey Map · {journey?.stops?.length ?? 0} stops
      </footer>
    </div>
  );
}
