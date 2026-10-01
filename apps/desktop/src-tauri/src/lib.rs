use diff_core::{BinaryDiff, BinaryOptions, DiffOptions, TextDiff};
use tauri::ipc::{InvokeBody, Request};

/// Same contract as the WebAssembly `diffText`: offsets are UTF-16 code units.
#[tauri::command]
fn diff_text(left: String, right: String, options: Option<DiffOptions>) -> TextDiff {
    let opts = options.unwrap_or_default();
    let mut diff = diff_core::diff_text(&left, &right, &opts);
    diff.convert_offsets_to_utf16(&left, &right);
    diff
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![diff_text, diff_bytes])
        .run(tauri::generate_context!())
        .expect("error while running Bigyo Master");
}
