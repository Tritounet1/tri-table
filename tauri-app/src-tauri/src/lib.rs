use std::error::Error;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

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
    edit_lock: Mutex<()>,
}

/// Sniffs the delimiter from the header line: whichever of `;`, tab, or `,`
/// appears most often wins, defaulting to `,` when none are present. Lets
/// files exported from tools that default to `;` (common with French-locale
/// Excel) open correctly instead of erroring on mismatched field counts.
fn detect_delimiter(sample: &str) -> u8 {
    let first_line = sample.lines().next().unwrap_or("");
    let count = |d: u8| first_line.bytes().filter(|&b| b == d).count();
    [(b';', count(b';')), (b'\t', count(b'\t')), (b',', count(b','))]
        .into_iter()
        .max_by_key(|&(_, c)| c)
        .filter(|&(_, c)| c > 0)
        .map(|(d, _)| d)
        .unwrap_or(b',')
}

fn read_csv_file<P: AsRef<Path>>(filename: P) -> Result<(CsvData, u8), Box<dyn Error>> {
    let content = std::fs::read_to_string(filename)?;
    let delimiter = detect_delimiter(&content);
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .from_reader(content.as_bytes());

    let headers = rdr.headers()?.iter().map(String::from).collect();
    let rows = rdr
        .records()
        .map(|result| result.map(|record| record.iter().map(String::from).collect()))
        .collect::<Result<Vec<Vec<String>>, csv::Error>>()?;

    Ok((CsvData { headers, rows }, delimiter))
}

/// Writes `data` to `path` atomically: a temp file is created in the same
/// directory (so the final rename stays on one filesystem) and swapped in
/// with `persist`, so readers never observe a partially-written file and no
/// lock is ever taken. `delimiter` is whatever `read_csv_file` detected for
/// this file, so editing never silently switches a `;`-delimited file to `,`.
fn write_csv_atomic(path: &Path, data: &CsvData, delimiter: u8) -> Result<(), Box<dyn Error>> {
    let parent = path
        .parent()
        .ok_or("CSV path has no parent directory")?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;

    {
        let mut wtr = csv::WriterBuilder::new()
            .delimiter(delimiter)
            .from_writer(&mut tmp);
        wtr.write_record(&data.headers)?;
        for row in &data.rows {
            wtr.write_record(row)?;
        }
        wtr.flush()?;
    }

    tmp.persist(path)?;
    Ok(())
}

/// Grows `data` so it has at least `min_cols` columns and `min_rows` rows,
/// padding with empty strings — lets the grid be edited past its current
/// bounds like a spreadsheet instead of rejecting out-of-range edits.
fn ensure_shape(data: &mut CsvData, min_cols: usize, min_rows: usize) {
    while data.headers.len() < min_cols {
        data.headers.push(String::new());
    }
    for row in data.rows.iter_mut() {
        while row.len() < data.headers.len() {
            row.push(String::new());
        }
    }
    while data.rows.len() < min_rows {
        data.rows.push(vec![String::new(); data.headers.len()]);
    }
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
        let Ok((new_data, _delimiter)) = read_csv_file(&watch_target) else {
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
    let (data, _delimiter) = read_csv_file(&path).map_err(|e| e.to_string())?;
    *state.last_data.lock().unwrap() = Some(data.clone());

    start_watching(Path::new(&path), app.clone(), &state)?;

    if let Some(window) = app.get_webview_window("main") {
        let name = Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&path);
        let _ = window.set_title(name);
    }

    Ok(data)
}

#[tauri::command]
fn update_cell(
    path: String,
    row: usize,
    col: usize,
    value: String,
    state: State<AppState>,
) -> Result<(), String> {
    let _guard = state.edit_lock.lock().unwrap();

    let (mut data, delimiter) = read_csv_file(&path).map_err(|e| e.to_string())?;
    ensure_shape(&mut data, col + 1, row + 1);
    data.rows[row][col] = value;

    write_csv_atomic(Path::new(&path), &data, delimiter).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_header(path: String, col: usize, value: String, state: State<AppState>) -> Result<(), String> {
    let _guard = state.edit_lock.lock().unwrap();

    let (mut data, delimiter) = read_csv_file(&path).map_err(|e| e.to_string())?;
    ensure_shape(&mut data, col + 1, 0);
    data.headers[col] = value;

    write_csv_atomic(Path::new(&path), &data, delimiter).map_err(|e| e.to_string())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let open_item = MenuItemBuilder::with_id("open_file", "Open File…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Tritable")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_item)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .fullscreen()
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![open_csv, update_cell, update_header])
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "open_file" {
                let _ = app.emit("menu-open-file", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
