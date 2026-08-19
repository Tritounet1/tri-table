import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import "./App.css";

interface CsvData {
  headers: string[];
  rows: string[][];
}

interface CsvChangedPayload {
  data: CsvData;
  changedCells: [number, number][];
}

const HIGHLIGHT_DURATION_MS = 1500;

function cellKey(row: number, column: number) {
  return `${row}-${column}`;
}

function App() {
  const [path, setPath] = useState<string | null>(null);
  const [data, setData] = useState<CsvData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const highlightTimeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const unlisten = listen<CsvChangedPayload>("csv-changed", (event) => {
      setData(event.payload.data);
      highlightCells(event.payload.changedCells);
    });

    const timeouts = highlightTimeouts.current;
    return () => {
      unlisten.then((fn) => fn());
      timeouts.forEach((timeout) => clearTimeout(timeout));
    };
  }, []);

  function highlightCells(cells: [number, number][]) {
    setHighlighted((prev) => {
      const next = new Set(prev);
      cells.forEach(([row, column]) => next.add(cellKey(row, column)));
      return next;
    });

    cells.forEach(([row, column]) => {
      const key = cellKey(row, column);
      const existing = highlightTimeouts.current.get(key);
      if (existing) {
        clearTimeout(existing);
      }
      const timeout = setTimeout(() => {
        setHighlighted((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        highlightTimeouts.current.delete(key);
      }, HIGHLIGHT_DURATION_MS);
      highlightTimeouts.current.set(key, timeout);
    });
  }

  async function openCsv() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!selected) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const csv = await invoke<CsvData>("open_csv", { path: selected });
      setPath(selected);
      setData(csv);
      setHighlighted(new Set());
    } catch (err) {
      setError(err as string);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 p-8 flex flex-col items-center gap-6 font-sans">
      <div className="flex items-center gap-3 self-start">
        <button
          onClick={openCsv}
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 font-medium cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          {loading ? "Loading..." : "Open CSV..."}
        </button>
        {path && (
          <span className="text-sm text-neutral-500 dark:text-neutral-400 truncate max-w-md">
            {path}
          </span>
        )}
      </div>

      {error && <p className="text-red-600 dark:text-red-400">Error: {error}</p>}

      {data && (
        <table className="w-full max-w-4xl border-collapse self-start">
          <thead>
            <tr>
              {data.headers.map((header, columnIndex) => (
                <th
                  key={columnIndex}
                  className="text-left px-3 py-2 font-semibold border-b border-neutral-200 dark:border-neutral-700"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, columnIndex) => (
                  <td key={columnIndex} className="px-3 py-1.5">
                    <input
                      type="text"
                      value={cell}
                      readOnly
                      className={`w-full px-2 py-1.5 rounded border border-transparent transition-colors duration-1000 ${
                        highlighted.has(cellKey(rowIndex, columnIndex))
                          ? "bg-amber-200 dark:bg-amber-800"
                          : "bg-neutral-50 dark:bg-neutral-800"
                      }`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

export default App;
