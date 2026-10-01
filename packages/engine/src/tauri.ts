import { invoke } from "@tauri-apps/api/core";
import type { DiffEngine, DiffOptions, TextDiff } from "./index";

/** Runs the native Rust engine through the Tauri `diff_text` command. */
export function createTauriEngine(): DiffEngine {
  return {
    diffText(left: string, right: string, options?: Partial<DiffOptions>) {
      return invoke<TextDiff>("diff_text", { left, right, options: options ?? null });
    },
  };
}
