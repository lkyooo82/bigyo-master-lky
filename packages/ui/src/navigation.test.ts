import { describe, expect, it } from "vitest";
import type { TextDiff } from "@bigyo/engine";
import { changeIndices, overviewMarks, stepChange } from "./navigation";

const span = (start: number, end: number) => ({ start, end });
const diff: TextDiff = {
  chunks: [
    { kind: "equal", left: span(0, 2), right: span(0, 2) },
    { kind: "insert", left: span(2, 2), right: span(2, 4) },
    { kind: "equal", left: span(2, 4), right: span(4, 6) },
    { kind: "replace", left: span(4, 6), right: span(6, 8) },
  ],
  pairs: [],
  stats: { leftLines: 6, rightLines: 8, inserted: 2, deleted: 0, modified: 2, changes: 2 },
};

describe("navigation", () => {
  it("lists differences", () => expect(changeIndices(diff)).toEqual([1, 3]));
  it("steps forward and back, clamping at the ends", () => {
    const c = changeIndices(diff);
    expect(stepChange(c, -1, 1)).toBe(1);
    expect(stepChange(c, 1, 1)).toBe(3);
    expect(stepChange(c, 3, 1)).toBe(3);
    expect(stepChange(c, 3, -1)).toBe(1);
    expect(stepChange(c, 1, -1)).toBe(1);
  });
  it("places overview marks on aligned rows", () => {
    expect(overviewMarks(diff)).toEqual([
      { chunk: 1, kind: "insert", top: 2 / 8, height: 2 / 8 },
      { chunk: 3, kind: "replace", top: 6 / 8, height: 2 / 8 },
    ]);
  });
});
