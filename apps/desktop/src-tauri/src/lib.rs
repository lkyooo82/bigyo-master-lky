use std::path::PathBuf;

use diff_core::folder::FsEntry;
use diff_core::{BinaryDiff, BinaryOptions, DiffOptions, Merge3, TextDiff};
use tauri::async_runtime::spawn_blocking;
use tauri::ipc::{InvokeBody, Request};

/// Same contract as the WebAssembly `diffText`: offsets are UTF-16 code units.
#[tauri::command]
fn diff_text(left: String, right: String, options: Option<DiffOptions>) -> TextDiff {
    let opts = options.unwrap_or_default();
    let mut diff = diff_core::diff_text(&left, &right, &opts);
    diff.convert_offsets_to_utf16(&left, &right);
    diff
}

/// Same contract as the WebAssembly `merge3`: ranges are line indices.
#[tauri::command]
fn merge3(base: String, left: String, right: String, options: Option<DiffOptions>) -> Merge3 {
    diff_core::merge3(&base, &left, &right, &options.unwrap_or_default())
}

/// Takes both inputs as one raw body (left bytes then right bytes) to avoid JSON-encoding
/// large files. Headers: `x-left-len` (byte count of the left input), optional `x-options`
/// (`BinaryOptions` as JSON). Runs off the main thread.
#[tauri::command]
async fn diff_bytes(request: Request<'_>) -> Result<BinaryDiff, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("diff_bytes expects a raw byte body".into());
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let left_len: usize = header("x-left-len")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n <= body.len())
        .ok_or("missing or invalid x-left-len header")?;
    let opts: BinaryOptions = match header("x-options") {
        Some(json) => serde_json::from_str(json).map_err(|e| e.to_string())?,
        None => BinaryOptions::default(),
    };
    let (left, right) = body.split_at(left_len);
    Ok(diff_core::diff_bytes(left, right, &opts))
}

/// Lists a folder recursively for folder compare, skipping names that match `exclude`.
#[tauri::command]
async fn scan_dir(path: PathBuf, exclude: Vec<String>) -> Result<Vec<FsEntry>, String> {
    spawn_blocking(move || diff_core::folder::scan_dir(&path, &exclude))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Compares two files byte by byte on disk, so folder compare never ships contents over IPC.
#[tauri::command]
async fn files_equal(left: PathBuf, right: PathBuf) -> Result<bool, String> {
    spawn_blocking(move || diff_core::folder::files_equal(&left, &right))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// A path given on the command line, made absolute.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchPath {
    path: PathBuf,
    exists: bool,
    is_dir: bool,
}

/// The paths the app was started with, e.g. `bigyo-master left.txt right.txt` from a Git tool's
/// external diff setting. Options (`-x`, such as macOS's `-psn_…`) are ignored. A missing path
/// is reported rather than rejected: Git tools pass one for a file that was added or deleted.
#[tauri::command]
fn launch_paths() -> Result<Vec<LaunchPath>, String> {
    std::env::args_os()
        .skip(1)
        .filter(|a| !a.to_string_lossy().starts_with('-'))
        .map(|a| {
            let path = std::path::absolute(&a).map_err(|e| e.to_string())?;
            let meta = std::fs::metadata(&path).ok();
            Ok(LaunchPath {
                exists: meta.is_some(),
                is_dir: meta.is_some_and(|m| m.is_dir()),
                path,
            })
        })
        .collect()
}

/// Copies a file or folder (overwriting, keeping modified times). Returns the number of files copied.
#[tauri::command]
async fn copy_entry(src: PathBuf, dst: PathBuf) -> Result<u64, String> {
    spawn_blocking(move || diff_core::folder::copy_entry(&src, &dst))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Writes a text file, creating its parent folders; used for files a folder merge combines.
#[tauri::command]
async fn write_text(path: PathBuf, text: String) -> Result<(), String> {
    spawn_blocking(move || diff_core::folder::write_file(&path, text.as_bytes()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Moves a file or folder to the system trash, so a deletion can be undone there.
#[tauri::command]
async fn trash_entry(path: PathBuf) -> Result<(), String> {
    spawn_blocking(move || trash::delete(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            diff_text,
            diff_bytes,
            scan_dir,
            files_equal,
            launch_paths,
            merge3,
            copy_entry,
            trash_entry,
            write_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bigyo Master");
}
