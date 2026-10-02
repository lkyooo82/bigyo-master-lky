import { describe, expect, it } from "vitest";
import type { TextDiff } from "@bigyo/engine";
import { changeIndices, overviewMarks, stepChange } from "./navigation";

const span = (start: number, end: number) => ({ start, end });
const diff: TextDiff = {
  chunks: [
    { kind: "equal", left: span(0, 2), right: span(0, 2), unimportant: false },
    { kind: "insert", left: span(2, 2), right: span(2, 4), unimportant: false },
    { kind: "equal", left: span(2, 4), right: span(4, 6), unimportant: false },
    { kind: "delete", left: span(4, 5), right: span(6, 6), unimportant: true },
    { kind: "replace", left: span(5, 7), right: span(6, 8), unimportant: false },
  ],
  pairs: [],
  stats: { leftLines: 7, rightLines: 8, inserted: 2, deleted: 0, modified: 2, changes: 2, unimportant: 1 },
  invalidPatterns: [],
};

describe("navigation", () => {
  it("lists differences", () => expect(changeIndices(diff)).toEqual([1, 4]));
  it("steps forward and back, clamping at the ends", () => {
    const c = changeIndices(diff);
    expect(stepChange(c, -1, 1)).toBe(1);
    expect(stepChange(c, 1, 1)).toBe(4);
    expect(stepChange(c, 4, 1)).toBe(4);
    expect(stepChange(c, 4, -1)).toBe(1);
    expect(stepChange(c, 1, -1)).toBe(1);
  });
  it("merges overview marks that would overlap", () => {
    const many: TextDiff = {
      ...diff,
      chunks: Array.from({ length: 4000 }, (_, i) => ({
        kind: i % 2 ? "replace" : "equal",
        left: span(i, i + 1),
        right: span(i, i + 1),
        unimportant: false,
      })),
    };
    const marks = overviewMarks(many);
    expect(marks.length).toBeLessThanOrEqual(500);
    expect(marks[0].chunk).toBe(1);
  });

  it("places overview marks on aligned rows", () => {
    expect(overviewMarks(diff)).toEqual([
      { chunk: 1, kind: "insert", top: 2 / 9, height: 2 / 9 },
      { chunk: 4, kind: "replace", top: 7 / 9, height: 2 / 9 },
    ]);
  });
});
