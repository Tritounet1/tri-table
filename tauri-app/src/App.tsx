import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

interface CsvData {
  headers: string[];
  rows: string[][];
}

interface CsvChangedPayload {
  data: CsvData;
  changedCells: [number, number][];
}

type EditAction =
  | { kind: "cell"; row: number; col: number; oldValue: string; newValue: string }
  | { kind: "header"; col: number; oldValue: string; newValue: string };

const HIGHLIGHT_DURATION_MS = 1500;
const EXTRA_COLUMNS = 4;
const EXTRA_ROWS = 20;

function cellKey(row: number, column: number) {
  return `${row}-${column}`;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function ensureShape(data: CsvData, minCols: number, minRows: number): CsvData {
  const headers = data.headers.slice();
  while (headers.length < minCols) headers.push("");
  const rows = data.rows.map((r) => {
    const row = r.slice();
    while (row.length < headers.length) row.push("");
    return row;
  });
  while (rows.length < minRows) rows.push(new Array(headers.length).fill(""));
  return { headers, rows };
}

function App() {
  const [path, setPath] = useState<string | null>(null);
  const [data, setData] = useState<CsvData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const highlightTimeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pathRef = useRef<string | null>(null);
  const undoStack = useRef<EditAction[]>([]);
  const redoStack = useRef<EditAction[]>([]);

  useEffect(() => {
    pathRef.current = path;
  }, [path]);

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

  function setCellValueLocal(row: number, col: number, value: string) {
    setData((prev) => {
      if (!prev) return prev;
      const grown = ensureShape(prev, col + 1, row + 1);
      const rows = grown.rows.map((r) => r.slice());
      rows[row][col] = value;
      return { headers: grown.headers, rows };
    });
  }

  function setHeaderValueLocal(col: number, value: string) {
    setData((prev) => {
      if (!prev) return prev;
      const grown = ensureShape(prev, col + 1, 0);
      const headers = grown.headers.slice();
      headers[col] = value;
      return { headers, rows: grown.rows };
    });
  }

  const applyCellEdit = useCallback(
    async (row: number, col: number, newValue: string, oldValue: string) => {
      const currentPath = pathRef.current;
      if (!currentPath) return;
      try {
        await invoke("update_cell", { path: currentPath, row, col, value: newValue });
      } catch (err) {
        setError(err as string);
        setCellValueLocal(row, col, oldValue);
      }
    },
    [],
  );

  const applyHeaderEdit = useCallback(async (col: number, newValue: string, oldValue: string) => {
    const currentPath = pathRef.current;
    if (!currentPath) return;
    try {
      await invoke("update_header", { path: currentPath, col, value: newValue });
    } catch (err) {
      setError(err as string);
      setHeaderValueLocal(col, oldValue);
    }
  }, []);

  const commitCellEdit = useCallback(
    (row: number, col: number, newValue: string) => {
      if (!data) return;
      const grown = ensureShape(data, col + 1, row + 1);
      const oldValue = grown.rows[row][col];
      if (oldValue === newValue) return;
      setCellValueLocal(row, col, newValue);
      undoStack.current.push({ kind: "cell", row, col, oldValue, newValue });
      redoStack.current = [];
      void applyCellEdit(row, col, newValue, oldValue);
    },
    [data, applyCellEdit],
  );

  const commitHeaderEdit = useCallback(
    (col: number, newValue: string) => {
      if (!data) return;
      const grown = ensureShape(data, col + 1, 0);
      const oldValue = grown.headers[col];
      if (oldValue === newValue) return;
      setHeaderValueLocal(col, newValue);
      undoStack.current.push({ kind: "header", col, oldValue, newValue });
      redoStack.current = [];
      void applyHeaderEdit(col, newValue, oldValue);
    },
    [data, applyHeaderEdit],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isUndo = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "z";
      const isRedo =
        (event.metaKey || event.ctrlKey) &&
        ((event.shiftKey && event.key === "z") || event.key === "y");

      if (isUndo) {
        event.preventDefault();
        const action = undoStack.current.pop();
        if (!action) return;
        redoStack.current.push(action);
        if (action.kind === "cell") {
          setCellValueLocal(action.row, action.col, action.oldValue);
          void applyCellEdit(action.row, action.col, action.oldValue, action.newValue);
        } else {
          setHeaderValueLocal(action.col, action.oldValue);
          void applyHeaderEdit(action.col, action.oldValue, action.newValue);
        }
      } else if (isRedo) {
        event.preventDefault();
        const action = redoStack.current.pop();
        if (!action) return;
        undoStack.current.push(action);
        if (action.kind === "cell") {
          setCellValueLocal(action.row, action.col, action.newValue);
          void applyCellEdit(action.row, action.col, action.newValue, action.oldValue);
        } else {
          setHeaderValueLocal(action.col, action.newValue);
          void applyHeaderEdit(action.col, action.newValue, action.oldValue);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [applyCellEdit, applyHeaderEdit]);

  const openCsv = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!selected) return;

    setError(null);
    try {
      const csv = await invoke<CsvData>("open_csv", { path: selected });
      setPath(selected);
      setData(csv);
      setHighlighted(new Set());
      undoStack.current = [];
      redoStack.current = [];
    } catch (err) {
      setError(err as string);
      setData(null);
    }
  }, []);

  useEffect(() => {
    const unlisten = listen("menu-open-file", () => {
      void openCsv();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [openCsv]);

  const errorBanner = error && (
    <div className="fixed top-2 left-1/2 -translate-x-1/2 z-30 px-3 py-1.5 rounded-md bg-red-600 text-white text-sm shadow-lg">
      {error}
    </div>
  );

  if (!data || !path) {
    return (
      <main className="h-screen bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 flex flex-col items-center justify-center gap-1 font-sans">
        <p className="text-lg font-semibold">Tritable</p>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Ouvre un fichier via File → Open File (⌘O)
        </p>
        {errorBanner}
      </main>
    );
  }

  const columnCount = data.headers.length + EXTRA_COLUMNS;
  const rowCount = data.rows.length + EXTRA_ROWS;

  return (
    <main className="h-screen bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 font-sans overflow-hidden">
      {errorBanner}
      <div className="h-full overflow-auto">
        <table className="border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-30 w-12 min-w-12 bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-800" />
              {Array.from({ length: columnCount }, (_, col) => (
                <th
                  key={col}
                  className="sticky top-0 z-20 min-w-[120px] bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 font-normal select-none px-2 py-1"
                >
                  {columnLetter(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="sticky left-0 z-10 bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 text-center select-none">
                1
              </td>
              {Array.from({ length: columnCount }, (_, col) => (
                <EditableCell
                  key={col}
                  value={data.headers[col] ?? ""}
                  bold
                  highlighted={false}
                  onCommit={(value) => commitHeaderEdit(col, value)}
                />
              ))}
            </tr>
            {Array.from({ length: rowCount }, (_, row) => (
              <tr key={row}>
                <td className="sticky left-0 z-10 bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 text-center select-none">
                  {row + 2}
                </td>
                {Array.from({ length: columnCount }, (_, col) => (
                  <EditableCell
                    key={col}
                    value={data.rows[row]?.[col] ?? ""}
                    highlighted={highlighted.has(cellKey(row, col))}
                    onCommit={(value) => commitCellEdit(row, col, value)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function EditableCell({
  value,
  highlighted,
  bold,
  onCommit,
}: {
  value: string;
  highlighted: boolean;
  bold?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <td className="p-0 border border-neutral-200 dark:border-neutral-800">
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) {
            onCommit(draft);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(value);
            e.currentTarget.blur();
          }
        }}
        className={`w-full min-w-[120px] px-2 py-1 bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400 transition-colors duration-1000 ${
          bold ? "font-medium bg-neutral-50 dark:bg-neutral-800/60" : ""
        } ${highlighted ? "bg-amber-100 dark:bg-amber-900/40" : ""}`}
      />
    </td>
  );
}

export default App;
