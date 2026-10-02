import { describe, expect, it } from "vitest";
import type { MergeRegion } from "@bigyo/engine";
import { alignment, buildResult, findConflicts, resolution, resolveBlock } from "./mergeModel";

const span = (start: number, end: number) => ({ start, end });
const region = (kind: MergeRegion["kind"], base: [number, number], left: [number, number], right: [number, number]): MergeRegion => ({
  kind,
  base: span(...base),
  left: span(...left),
  right: span(...right),
});

// base "a\nb\nc", left "A\nb\nL", right "a\nb\nR": left changed line 0, both changed line 2.
const inputs = { base: "a\nb\nc", left: "A\nb\nL", right: "a\nb\nR" };
const regions = [region("left", [0, 1], [0, 1], [0, 1]), region("unchanged", [1, 2], [1, 2], [1, 2]), region("conflict", [2, 3], [2, 3], [2, 3])];

describe("merge result", () => {
  it("applies one-sided changes and writes conflict blocks", () => {
    expect(buildResult(regions, inputs)).toBe(
      ["A", "b", "<<<<<<< 왼쪽 (충돌 1)", "L", "||||||| 기준", "c", "=======", "R", ">>>>>>> 오른쪽 (충돌 1)"].join("\n"),
    );
  });

  it("finds and resolves conflict blocks", () => {
    const text = buildResult(regions, inputs);
    const [block] = findConflicts(text);
    expect(block).toEqual({ start: 2, end: 8, id: 1, left: ["L"], base: ["c"], right: ["R"] });
    expect(resolveBlock(text, block, resolution(block, "right"))).toBe("A\nb\nR");
    expect(resolveBlock(text, block, resolution(block, "leftRight"))).toBe("A\nb\nL\nR");
    expect(resolveBlock(text, block, resolution(block, "base"))).toBe("A\nb\nc");
    expect(findConflicts(resolveBlock(text, block, ["x"]))).toEqual([]);
  });

  it("reads Git's two-way blocks and ignores unfinished ones", () => {
    const blocks = findConflicts(["x", "<<<<<<< HEAD", "l", "=======", "r", ">>>>>>> theirs", "<<<<<<< broken", "y"].join("\n"));
    expect(blocks).toEqual([{ start: 1, end: 5, id: null, left: ["l"], base: null, right: ["r"] }]);
  });

  it("pads panes so regions line up", () => {
    const r = [region("conflict", [0, 1], [0, 3], [0, 0]), region("unchanged", [1, 2], [3, 4], [0, 1])];
    expect(alignment(r)).toEqual([
      { left: 0, base: 2, right: 3 },
      { left: 0, base: 0, right: 0 },
    ]);
  });
});
