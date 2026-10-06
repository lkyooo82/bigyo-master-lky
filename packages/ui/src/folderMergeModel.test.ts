import { describe, expect, it } from "vitest";
import {
  countMerge,
  filterMerge,
  folderDecision,
  mergeAncestors,
  mergeRows,
  mergeTrees,
  pairKey,
  pendingComparisons,
  pickAll,
  planMerge,
  stepUndecided,
  type Decision,
  type MergeNode,
} from "./folderMergeModel";
import { signature, type FolderEntry } from "./folderTree";

const file = (name: string, size: number, modified = 1000): FolderEntry => ({ name, kind: "file", size, modified, children: [] });
const dir = (name: string, children: FolderEntry[]): FolderEntry => ({ name, kind: "dir", size: 0, modified: 0, children });
const none = new Map();
const flat = (nodes: MergeNode[], out: Record<string, string> = {}) => {
  for (const n of nodes) {
    out[n.path] = n.status;
    flat(n.children, out);
  }
  return out;
};
const picks = (o: Record<string, Decision> = {}) => new Map(Object.entries(o));

describe("mergeTrees", () => {
  // Sizes stand for contents: the same size means the same file in "quick" mode.
  const base = [dir("src", [file("a", 1), file("b", 1), file("c", 1), file("d", 1), file("gone", 1)]), file("x", 1), file("k", 1)];
  const left = [dir("src", [file("a", 2), file("b", 1), file("c", 3), file("d", 4), file("new", 1)]), file("x", 1), dir("k", [])];
  const right = [dir("src", [file("a", 1), file("b", 5), file("c", 3), file("d", 6)]), file("x", 1), file("k", 1), dir("added", [])];
  const tree = mergeTrees({ left, base, right }, "quick", none);

  it("decides what each side did", () => {
    expect(flat(tree)).toEqual({
      added: "right",
      src: "conflict",
      "src/a": "left",
      "src/b": "right",
      "src/c": "both",
      "src/d": "conflict",
      "src/gone": "both",
      "src/new": "left",
      k: "conflict",
      x: "same",
    });
    expect(tree.find((n) => n.path === "k")!.clash).toBe(true);
  });

  it("counts files and the conflicts left to decide", () => {
    const c = countMerge(tree, picks());
    expect(c).toMatchObject({ left: 2, right: 2, both: 2, conflict: 2, same: 1, undecided: 2 });
    expect(countMerge(tree, picks({ "src/d": "merge", k: "left" })).undecided).toBe(0);
  });

  it("treats delete against modify as a conflict", () => {
    const t = mergeTrees({ base: [file("f", 1)], left: [], right: [file("f", 2)] }, "quick", none);
    expect(t[0].status).toBe("conflict");
    expect(t[0].leftChange).toBe("deleted");
    expect(t[0].rightChange).toBe("modified");
  });

  it("asks for content comparisons, then uses them", () => {
    const b = [dir("d", [file("f", 4)])];
    const l = [dir("d", [file("f", 4, 1)])];
    const r = [dir("d", [file("f", 4, 2)])];
    const t = mergeTrees({ left: l, base: b, right: r }, "content", none);
    expect(t[0].status).toBe("pending");
    expect(pendingComparisons(t).map((p) => p.pair)).toEqual(["LB", "RB"]);
    const v = new Map<string, { result: "same" | "different"; sig: string }>([
      [pairKey("d/f", "LB"), { result: "different", sig: signature(l[0].children[0], b[0].children[0]) }],
      [pairKey("d/f", "RB"), { result: "different", sig: signature(r[0].children[0], b[0].children[0]) }],
    ]);
    const t2 = mergeTrees({ left: l, base: b, right: r }, "content", v);
    expect(pendingComparisons(t2).map((p) => p.pair)).toEqual(["LR"]);
    v.set(pairKey("d/f", "LR"), { result: "same", sig: signature(l[0].children[0], r[0].children[0]) });
    expect(mergeTrees({ left: l, base: b, right: r }, "content", v)[0].status).toBe("both");
  });

  it("looks inside folders with conflicts for comparisons still needed", () => {
    const t = mergeTrees({ base: [dir("d", [file("a", 1), file("b", 4)])], left: [dir("d", [file("a", 2), file("b", 4, 5)])], right: [dir("d", [file("a", 3), file("b", 4)])] }, "content", none);
    expect(t[0].status).toBe("conflict");
    expect(pendingComparisons(t).map((p) => `${p.path}:${p.pair}`)).toEqual(["d/b:LB", "d/b:RB"]);
  });
});

describe("planMerge", () => {
  const base = [dir("lib", [file("a", 1), file("b", 1)]), file("f", 1), file("g", 1)];
  const left = [dir("lib", [file("a", 1), file("b", 1)]), file("f", 2), file("g", 1), dir("docs", [file("r", 1)])];
  const right = [file("f", 1), file("g", 3), file("h", 1)];
  const tree = mergeTrees({ left, base, right }, "quick", none);

  it("into the left folder, brings over only the right side's changes", () => {
    // Right deleted lib (unchanged on the left), changed g and added h.
    expect(planMerge(tree, picks(), "left")).toEqual({
      actions: [
        { op: "remove", path: "lib", kind: "dir" },
        { op: "copy", from: "right", path: "g", kind: "file" },
        { op: "copy", from: "right", path: "h", kind: "file" },
      ],
      undecided: [],
    });
  });

  it("into the right folder, brings over the left side's changes", () => {
    expect(planMerge(tree, picks(), "right").actions).toEqual([
      { op: "copy", from: "left", path: "docs", kind: "dir" },
      { op: "copy", from: "left", path: "f", kind: "file" },
    ]);
  });

  it("into another folder, copies every kept entry", () => {
    expect(planMerge(tree, picks(), "other").actions).toEqual([
      { op: "copy", from: "left", path: "docs", kind: "dir" },
      { op: "copy", from: "left", path: "f", kind: "file" },
      { op: "copy", from: "right", path: "g", kind: "file" },
      { op: "copy", from: "right", path: "h", kind: "file" },
    ]);
  });

  it("follows picks, lists undecided conflicts, and skips files merged by hand", () => {
    const t = mergeTrees({ base: [file("c", 1), file("m", 1), file("n", 1)], left: [file("c", 2), file("m", 2), file("n", 2)], right: [file("c", 3), file("m", 3), file("n", 3)] }, "quick", none);
    expect(planMerge(t, picks({ m: "merge", n: "manual" }), "left")).toEqual({ actions: [{ op: "merge", path: "m" }], undecided: ["c"] });
    expect(planMerge(t, picks({ c: "base" }), "left").actions).toEqual([{ op: "copy", from: "base", path: "c", kind: "file" }]);
  });

  it("removes an entry of the other kind before copying", () => {
    const t = mergeTrees({ base: [file("k", 1)], left: [dir("k", [file("z", 1)])], right: [file("k", 2)] }, "quick", none);
    expect(planMerge(t, picks({ k: "left" }), "right").actions).toEqual([
      { op: "remove", path: "k", kind: "file" },
      { op: "copy", from: "left", path: "k", kind: "dir" },
    ]);
  });

  it("walks into a folder whose files come from different sides", () => {
    const t = mergeTrees({ base: [dir("d", [file("a", 1), file("b", 1)])], left: [dir("d", [file("a", 2), file("b", 1)])], right: [dir("d", [file("a", 1), file("b", 2)])] }, "quick", none);
    expect(planMerge(t, picks(), "other").actions).toEqual([
      { op: "copy", from: "left", path: "d/a", kind: "file" },
      { op: "copy", from: "right", path: "d/b", kind: "file" },
    ]);
  });
});

describe("decisions", () => {
  const t = mergeTrees(
    { base: [dir("d", [file("a", 1), file("b", 1)])], left: [dir("d", [file("a", 2), file("b", 2)])], right: [dir("d", [file("a", 3), file("b", 1)])] },
    "quick",
    none,
  );
  const rows = mergeRows(t);

  it("steps to entries that still need a decision", () => {
    expect(stepUndecided(rows, null, 1, picks())).toBe(1);
    expect(stepUndecided(rows, "d/a", 1, picks())).toBe(-1);
    expect(stepUndecided(rows, null, 1, picks({ "d/a": "right" }))).toBe(-1);
    expect(mergeAncestors(rows, "d/a")).toEqual(["d"]);
  });

  it("sets a folder's entries at once and shows what they share", () => {
    expect(folderDecision(t[0], picks())).toBeNull();
    const all = pickAll(t[0], "right", picks());
    expect(folderDecision(t[0], all)).toBe("right");
    expect(folderDecision(t[0], new Map([...all, ["d/b", "left"]]))).toBe("mixed");
    // A line merge only applies to files both sides have.
    const merged = pickAll(t[0], "merge", picks());
    expect([...merged]).toEqual([["d/a", "merge"], ["d/b", "merge"]]);
  });

  it("filters to changes and conflicts", () => {
    expect(mergeRows(filterMerge(t, "conflicts")).map((r) => r.node.path)).toEqual(["d", "d/a"]);
    expect(mergeRows(filterMerge(t, "changes")).map((r) => r.node.path)).toEqual(["d", "d/a", "d/b"]);
  });
});
