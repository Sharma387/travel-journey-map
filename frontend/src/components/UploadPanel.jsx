import { useRef, useState } from "react";

export default function UploadPanel({ onParse, busy }) {
  const [file, setFile] = useState(null);
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const selectFile = (list) => {
    const f = list && list[0];
    if (f) setFile(f);
  };

  const submit = () => {
    if (!file && !text.trim()) return;
    onParse(file ? { file } : { text });
  };

  const loadSample = async () => {
    const res = await fetch("/sample_itinerary.txt");
    setText(await res.text());
    setFile(null);
  };

  return (
    <div className="space-y-3">
      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          selectFile(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
          dragOver ? "border-blue-500 bg-blue-50" : "border-slate-300 hover:border-blue-400 hover:bg-slate-50"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.xlsx,.xls,.csv,.txt,.md,.markdown"
          className="hidden"
          onChange={(e) => selectFile(e.target.files)}
        />
        <div className="text-2xl">📄</div>
        <p className="mt-1 text-sm font-medium text-slate-600">Drop a file here or click to browse</p>
        <p className="text-xs text-slate-400">PDF · Excel · CSV · TXT</p>
        {file && (
          <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
            {file.name}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setFile(null);
              }}
              className="text-blue-500 hover:text-blue-800"
            >
              ✕
            </button>
          </span>
        )}
      </div>

      {/* Text input */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={
          "\u2026or paste a messy itinerary here, e.g.:\n" +
          "Day 1 (June 3): Landed in Lisbon, walked Alfama\n" +
          "June 4: Sintra \u2014 Pena Palace all morning"
        }
        className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-sm focus:border-blue-400 focus:outline-none"
      />

      {/* Buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy || (!file && !text.trim())}
          className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Working\u2026" : "Parse itinerary"}
        </button>
        <button
          onClick={loadSample}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Load sample
        </button>
      </div>
    </div>
  );
}