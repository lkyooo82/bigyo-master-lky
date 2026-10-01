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

describe("wasm byte diff", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("finds an insertion in smart mode", async () => {
    const d = await engine.diffBytes(bytes("HEADER-payload"), bytes("HEADER-new-payload"));
    expect(d.mode).toBe("smart");
    expect(d.chunks.map((c) => c.kind)).toEqual(["equal", "insert", "equal"]);
    expect(d.stats.inserted).toBe(4);
  });

  it("compares by offset in aligned mode", async () => {
    const d = await engine.diffBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3, 4]), { mode: "aligned" });
    expect(d.chunks).toEqual([
      { kind: "equal", left: { start: 0, end: 1 }, right: { start: 0, end: 1 } },
      { kind: "replace", left: { start: 1, end: 2 }, right: { start: 1, end: 2 } },
      { kind: "equal", left: { start: 2, end: 3 }, right: { start: 2, end: 3 } },
      { kind: "insert", left: { start: 3, end: 3 }, right: { start: 3, end: 4 } },
    ]);
  });
});
