//! Browser bindings for diff-core.

use diff_core::{BinaryOptions, DiffOptions};
use wasm_bindgen::prelude::*;

/// Compares two texts. `options` is a partial `DiffOptions` object (camelCase keys); offsets in
/// the result are UTF-16 code units, matching JavaScript strings.
#[wasm_bindgen(js_name = diffText)]
pub fn diff_text(left: &str, right: &str, options: JsValue) -> Result<JsValue, JsError> {
    let opts: DiffOptions = if options.is_undefined() || options.is_null() {
        DiffOptions::default()
    } else {
        serde_wasm_bindgen::from_value(options)?
    };
    let mut diff = diff_core::diff_text(left, right, &opts);
    diff.convert_offsets_to_utf16(left, right);
    Ok(serde_wasm_bindgen::to_value(&diff)?)
}

/// Compares two byte arrays for the hex view. `options` is a partial `BinaryOptions` object.
#[wasm_bindgen(js_name = diffBytes)]
pub fn diff_bytes(left: &[u8], right: &[u8], options: JsValue) -> Result<JsValue, JsError> {
    let opts: BinaryOptions = if options.is_undefined() || options.is_null() {
        BinaryOptions::default()
    } else {
        serde_wasm_bindgen::from_value(options)?
    };
    Ok(serde_wasm_bindgen::to_value(&diff_core::diff_bytes(
        left, right, &opts,
    ))?)
}
