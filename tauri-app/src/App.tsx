import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import "./App.css";

interface CsvData {
  headers: string[];
  rows: string[][];
}

function App() {
  const [path, setPath] = useState<string | null>(null);
  const [data, setData] = useState<CsvData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const csv = await invoke<CsvData>("read_csv", { path: selected });
      setPath(selected);
      setData(csv);
    } catch (err) {
      setError(err as string);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <div className="toolbar">
        <button onClick={openCsv} disabled={loading}>
          {loading ? "Loading..." : "Open CSV..."}
        </button>
        {path && <span className="path">{path}</span>}
      </div>

      {error && <p className="error">Error: {error}</p>}

      {data && (
        <table>
          <thead>
            <tr>
              {data.headers.map((header, columnIndex) => (
                <th key={columnIndex}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, columnIndex) => (
                  <td key={columnIndex}>
                    <input type="text" value={cell} readOnly />
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
