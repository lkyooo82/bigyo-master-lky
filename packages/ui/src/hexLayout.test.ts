import { describe, expect, it } from "vitest";
import type { BinaryDiff } from "@bigyo/engine";
import { asciiChar, chunkAtCell, hexByte, hexLayout, rowCells } from "./hexLayout";

const span = (start: number, end: number) => ({ start, end });
const diff: BinaryDiff = {
  chunks: [
    { kind: "equal", left: span(0, 10), right: span(0, 10) },
    { kind: "insert", left: span(10, 10), right: span(10, 14) },
    { kind: "replace", left: span(10, 12), right: span(14, 15) },
    { kind: "equal", left: span(12, 30), right: span(15, 33) },
  ],
  stats: { leftLen: 30, rightLen: 33, changes: 2, changed: 2, inserted: 4, deleted: 0 },
  mode: "smart",
};

describe("hex layout", () => {
  const layout = hexLayout(diff);

  it("counts aligned cells", () => {
    expect(layout.cellStart).toEqual([0, 10, 14, 16]);
    expect(layout.totalCells).toBe(34);
    expect(layout.rows).toBe(3);
  });

  it("finds chunks by cell", () => {
    expect([0, 9, 10, 13, 14, 15, 16, 33].map((c) => chunkAtCell(layout, c))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it("leaves gaps where a side has no byte", () => {
    const row = rowCells(diff, layout, 0);
    expect(row).toHaveLength(16);
    expect(row[10]).toEqual({ left: null, right: 10, kind: "insert", chunk: 1 });
    expect(row[14]).toEqual({ left: 10, right: 14, kind: "replace", chunk: 2 });
    expect(row[15]).toEqual({ left: 11, right: null, kind: "replace", chunk: 2 });
    expect(rowCells(diff, layout, 2)).toHaveLength(2);
  });

  it("formats bytes", () => {
    expect(hexByte(10)).toBe("0A");
    expect(asciiChar(0x41) + asciiChar(0)).toBe("A.");
  });
});
