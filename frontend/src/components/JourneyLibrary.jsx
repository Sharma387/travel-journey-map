import { useState } from "react";

function fmtDate(d) {
  if (!d) return "";
  return d;
}

export default function JourneyLibrary({ journeys, onOpen, onNew, onDelete, busy }) {
  const [confirmDelete, setConfirmDelete] = useState(null);

  return (
    <div className="mx-auto w-full max-w-3xl p-4 lg:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-slate-800">
            My journeys
          </h1>
          <p className="text-xs text-slate-400">
            {journeys.length
              ? `${journeys.length} saved journey${journeys.length === 1 ? "" : "s"}`
              : "No journeys yet — create your first one"}
          </p>
        </div>
        <button
          onClick={onNew}
          className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + New journey
        </button>
      </div>

      {journeys.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <div className="text-2xl">🧳</div>
          <p className="mt-2 text-sm font-medium text-slate-600">
            Your journey map is empty
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Upload an itinerary (PDF, Excel, CSV or text) to create your first
            journey.
          </p>
          <button
            onClick={onNew}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Create a journey
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {journeys.map((j) => (
            <li
              key={j.id}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
            >
              <button
                onClick={() => onOpen(j.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-sm font-semibold text-slate-800">
                  {j.title || "Untitled journey"}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  {j.stop_count} stop{j.stop_count === 1 ? "" : "s"}
                  {j.first_date ? ` · ${fmtDate(j.first_date)}` : ""}
                  {j.last_date && j.last_date !== j.first_date
                    ? ` → ${fmtDate(j.last_date)}`
                    : ""}
                </div>
              </button>
              <button
                onClick={() => onOpen(j.id)}
                className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Open
              </button>
              <button
                onClick={() => {
                  if (confirmDelete === j.id) {
                    setConfirmDelete(null);
                    onDelete(j.id);
                  } else {
                    setConfirmDelete(j.id);
                    setTimeout(() => setConfirmDelete(null), 3000);
                  }
                }}
                disabled={busy}
                className={`rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-40 ${
                  confirmDelete === j.id
                    ? "border-red-400 bg-red-600 text-white"
                    : "border-slate-200 text-slate-400 hover:bg-red-50 hover:text-red-600"
                }`}
              >
                {confirmDelete === j.id ? "Confirm?" : "Delete"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
