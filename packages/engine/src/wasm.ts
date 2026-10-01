import type { DiffEngine, DiffOptions, TextDiff } from "./index";
import init, { diffText } from "../wasm/diff_wasm.js";

/** Loads the WebAssembly engine. `wasm` overrides where the binary comes from (e.g. bytes in Node). */
export async function createWasmEngine(wasm?: BufferSource | URL | string): Promise<DiffEngine> {
  await init(wasm === undefined ? undefined : { module_or_path: wasm });
  return {
    async diffText(left: string, right: string, options?: Partial<DiffOptions>) {
      return diffText(left, right, options ?? {}) as TextDiff;
    },
  };
}
