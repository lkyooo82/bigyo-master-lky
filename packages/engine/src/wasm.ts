import type { BinaryDiff, BinaryOptions, DiffEngine, DiffOptions, Merge3, TextDiff } from "./index";
import init, { diffBytes, diffText, merge3 } from "../wasm/diff_wasm.js";

/** Loads the WebAssembly engine. `wasm` overrides where the binary comes from (e.g. bytes in Node). */
export async function createWasmEngine(wasm?: BufferSource | URL | string): Promise<DiffEngine> {
  await init(wasm === undefined ? undefined : { module_or_path: wasm });
  return {
    async diffText(left: string, right: string, options?: Partial<DiffOptions>) {
      return diffText(left, right, options ?? {}) as TextDiff;
    },
    async diffBytes(left: Uint8Array, right: Uint8Array, options?: Partial<BinaryOptions>) {
      return diffBytes(left, right, options ?? {}) as BinaryDiff;
    },
    async merge3(base: string, left: string, right: string, options?: Partial<DiffOptions>) {
      return merge3(base, left, right, options ?? {}) as Merge3;
    },
  };
}
