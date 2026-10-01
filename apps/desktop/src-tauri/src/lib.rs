use diff_core::{DiffOptions, TextDiff};

/// Same contract as the WebAssembly `diffText`: offsets are UTF-16 code units.
#[tauri::command]
fn diff_text(left: String, right: String, options: Option<DiffOptions>) -> TextDiff {
    let opts = options.unwrap_or_default();
    let mut diff = diff_core::diff_text(&left, &right, &opts);
    diff.convert_offsets_to_utf16(&left, &right);
    diff
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![diff_text])
        .run(tauri::generate_context!())
        .expect("error while running Bigyo Master");
}
