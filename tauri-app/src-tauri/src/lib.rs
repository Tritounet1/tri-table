use std::error::Error;
use std::fs::File;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Clone, PartialEq)]
struct CsvData {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CsvChangedPayload {
    data: CsvData,
    changed_cells: Vec<(usize, usize)>,
}

#[derive(Default)]
struct AppState {
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    last_data: Mutex<Option<CsvData>>,
}

fn read_csv_file<P: AsRef<Path>>(filename: P) -> Result<CsvData, Box<dyn Error>> {
    let file = File::open(filename)?;
    let mut rdr = csv::Reader::from_reader(file);

    let headers = rdr.headers()?.iter().map(String::from).collect();
    let rows = rdr
        .records()
        .map(|result| result.map(|record| record.iter().map(String::from).collect()))
        .collect::<Result<Vec<Vec<String>>, csv::Error>>()?;

    Ok(CsvData { headers, rows })
}

fn all_cells(data: &CsvData) -> Vec<(usize, usize)> {
    data.rows
        .iter()
        .enumerate()
        .flat_map(|(i, row)| (0..row.len()).map(move |j| (i, j)))
        .collect()
}

/// Cell-level diff. A shape change (headers or row/column counts differ)
/// is treated as "everything changed" rather than aligned — line-level
/// insert/delete alignment is out of scope for Phase 1.
fn diff_cells(old: &CsvData, new: &CsvData) -> Vec<(usize, usize)> {
    if old.headers != new.headers || old.rows.len() != new.rows.len() {
        return all_cells(new);
    }

    let mut changed = Vec::new();
    for (i, (old_row, new_row)) in old.rows.iter().zip(new.rows.iter()).enumerate() {
        if old_row.len() != new_row.len() {
            changed.extend((0..new_row.len()).map(|j| (i, j)));
            continue;
        }
        for (j, (a, b)) in old_row.iter().zip(new_row.iter()).enumerate() {
            if a != b {
                changed.push((i, j));
            }
        }
    }
    changed
}

/// Watches the parent directory (not the file itself) so that atomic
/// temp-file+rename replacements — used by editors and, eventually, by
/// Tritable's own writer — are still caught even though they swap the
/// underlying inode.
fn start_watching(path: &Path, app: AppHandle, state: &State<AppState>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "CSV path has no parent directory".to_string())?
        .to_path_buf();
    let watch_target = path.to_path_buf();
    let handle = app.clone();

    let mut debouncer = new_debouncer(Duration::from_millis(200), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        if !events.iter().any(|e| e.path == watch_target) {
            return;
        }
        let Ok(new_data) = read_csv_file(&watch_target) else {
            return;
        };

        let state: State<AppState> = handle.state();
        let mut last_data = state.last_data.lock().unwrap();
        let changed_cells = match last_data.as_ref() {
            Some(old) => diff_cells(old, &new_data),
            None => all_cells(&new_data),
        };
        *last_data = Some(new_data.clone());
        drop(last_data);

        let _ = handle.emit(
            "csv-changed",
            CsvChangedPayload {
                data: new_data,
                changed_cells,
            },
        );
    })
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    *state.watcher.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[tauri::command]
fn open_csv(path: String, app: AppHandle, state: State<AppState>) -> Result<CsvData, String> {
    let data = read_csv_file(&path).map_err(|e| e.to_string())?;
    *state.last_data.lock().unwrap() = Some(data.clone());

    start_watching(Path::new(&path), app, &state)?;

    Ok(data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![open_csv])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
