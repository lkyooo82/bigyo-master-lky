import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createWasmEngine } from "./wasm";

const bytes = await readFile(new URL("../wasm/diff_wasm_bg.wasm", import.meta.url));
const engine = await createWasmEngine(bytes);

describe("wasm engine", () => {
  it("returns chunks, pairs and stats", async () => {
    const d = await engine.diffText("a\nb\nc", "a\nB\nc");
    expect(d.chunks.map((c) => c.kind)).toEqual(["equal", "replace", "equal"]);
    expect(d.chunks[1]).toEqual({ kind: "replace", left: { start: 1, end: 2 }, right: { start: 1, end: 2 } });
    expect(d.stats.modified).toBe(1);
  });

  it("uses UTF-16 offsets and accepts partial options", async () => {
    const d = await engine.diffText("가나 x", "가나 y", { inline: "char" });
    expect(d.pairs[0].leftRanges).toEqual([{ start: 3, end: 4 }]);
    const same = await engine.diffText("A  b", "a b", { ignoreCase: true, whitespace: "collapse" });
    expect(same.stats.changes).toBe(0);
  });
});
