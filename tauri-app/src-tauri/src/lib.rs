use std::error::Error;
use std::fs::File;
use std::path::Path;

use serde::Serialize;

#[derive(Serialize)]
struct CsvData {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
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

#[tauri::command]
fn read_csv(path: String) -> Result<CsvData, String> {
    read_csv_file(path).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_csv])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
