import { invoke } from "@tauri-apps/api/core";
import type { BinaryDiff, BinaryOptions, DiffEngine, DiffOptions, TextDiff } from "./index";

/** Runs the native Rust engine through Tauri commands. */
export function createTauriEngine(): DiffEngine {
  return {
    diffText(left: string, right: string, options?: Partial<DiffOptions>) {
      return invoke<TextDiff>("diff_text", { left, right, options: options ?? null });
    },
    diffBytes(left: Uint8Array, right: Uint8Array, options?: Partial<BinaryOptions>) {
      // One raw body instead of JSON arrays: large files stay fast.
      const body = new Uint8Array(left.length + right.length);
      body.set(left);
      body.set(right, left.length);
      return invoke<BinaryDiff>("diff_bytes", body, {
        headers: { "x-left-len": String(left.length), "x-options": JSON.stringify(options ?? {}) },
      });
    },
  };
}
