import { describe, expect, it } from "vitest";
import {
  allRows,
  ancestorsOf,
  compareTrees,
  countFiles,
  filterTree,
  globMatch,
  parseExclude,
  pendingFiles,
  planSync,
  signature,
  stepDifference,
  visibleRows,
  type FolderEntry,
  type FolderNode,
} from "./folderTree";

const file = (name: string, size: number, modified = 1000): FolderEntry => ({ name, kind: "file", size, modified, children: [] });
const dir = (name: string, children: FolderEntry[]): FolderEntry => ({ name, kind: "dir", size: 0, modified: 0, children });
const none = new Map();
/** Verdicts for files whose entries are `file(name, size)` with the default time. */
const verdicts = (size: number, results: Record<string, "same" | "different">) => {
  const f = file("", size);
  return new Map(Object.entries(results).map(([path, result]) => [path, { result, sig: signature(f, f) }]));
};
const byPath = (nodes: FolderNode[]) => Object.fromEntries(allRows(nodes).map((r) => [r.node.key, r.node.status]));

describe("compareTrees", () => {
  const left = [dir("src", [file("a.ts", 10), file("b.ts", 5), file("old.ts", 1)]), file("README.md", 3), file("empty", 0), file("x", 1)];
  const right = [dir("src", [file("a.ts", 10), file("b.ts", 6), dir("new", [file("n.ts", 1)])]), file("README.md", 3), file("empty", 0), dir("x", [])];

  it("matches entries by name and finds one-sided ones", () => {
    const tree = compareTrees(left, right, "content", none);
    expect(byPath(tree)).toEqual({
      src: "different",
      "src/new": "rightOnly",
      "src/new/n.ts": "rightOnly",
      "src/a.ts": "pending",
      "src/b.ts": "different",
      "src/old.ts": "leftOnly",
      "x#right": "rightOnly",
      empty: "same",
      "README.md": "pending",
      "x#left": "leftOnly",
    });
    // Folders first, then names.
    expect(tree.map((n) => n.key)).toEqual(["src", "x#right", "empty", "README.md", "x#left"]);
  });

  it("uses content verdicts, and folders take the worst child status", () => {
    const l = [dir("d", [file("a", 4), file("b", 4)])];
    const r = [dir("d", [file("a", 4), file("b", 4)])];
    expect(compareTrees(l, r, "content", none)[0].status).toBe("pending");
    expect(compareTrees(l, r, "content", verdicts(4, { "d/a": "same" }))[0].status).toBe("pending");
    expect(compareTrees(l, r, "content", verdicts(4, { "d/a": "same", "d/b": "same" }))[0].status).toBe("same");
    expect(compareTrees(l, r, "content", verdicts(4, { "d/a": "same", "d/b": "different" }))[0].status).toBe("different");
  });

  it("drops a verdict once either file changes", () => {
    const v = verdicts(4, { a: "same" });
    expect(compareTrees([file("a", 4)], [file("a", 4)], "content", v)[0].status).toBe("same");
    expect(compareTrees([file("a", 4)], [file("a", 4, 5000)], "content", v)[0].status).toBe("pending");
  });

  it("quick mode trusts size and time, within two seconds", () => {
    const tree = compareTrees([file("a", 4, 10_000), file("b", 4, 10_000)], [file("a", 4, 11_500), file("b", 4, 20_000)], "quick", none);
    expect(byPath(tree)).toEqual({ a: "same", b: "different" });
    expect(tree[1].newer).toBe("right");
  });

  it("lists pending paths and counts files", () => {
    const tree = compareTrees(left, right, "content", none);
    expect(pendingFiles(tree).map((n) => n.path)).toEqual(["src/a.ts", "README.md"]);
    expect(countFiles(tree)).toEqual({ same: 1, different: 1, leftOnly: 2, rightOnly: 1, pending: 2, error: 0 });
  });
});

describe("rows and filters", () => {
  const tree = compareTrees(
    [dir("a", [file("same", 1), file("diff", 1)]), dir("gone", [file("g", 1)]), file("top", 1)],
    [dir("a", [file("same", 1), file("diff", 2)]), file("top", 1)],
    "content",
    verdicts(1, { "a/same": "same", top: "same" }),
  );

  it("shows expanded folders only", () => {
    expect(visibleRows(tree, new Set()).map((r) => r.node.key)).toEqual(["a", "gone", "top"]);
    expect(visibleRows(tree, new Set(["a"])).map((r) => [r.node.key, r.depth])).toEqual([["a", 0], ["a/diff", 1], ["a/same", 1], ["gone", 0], ["top", 0]]);
  });

  it("filters by status, keeping folders that hold matches", () => {
    const keys = (f: Parameters<typeof filterTree>[1]) => allRows(filterTree(tree, f)).map((r) => r.node.key);
    expect(keys("diff")).toEqual(["a", "a/diff", "gone", "gone/g"]);
    expect(keys("same")).toEqual(["a", "a/same", "top"]);
    expect(keys("orphans")).toEqual(["gone", "gone/g"]);
  });

  it("steps between differences, treating a one-sided folder as one stop", () => {
    const rows = allRows(tree);
    const at = (i: number) => (i < 0 ? null : rows[i].node.key);
    expect(at(stepDifference(rows, null, 1))).toBe("a/diff");
    expect(at(stepDifference(rows, "a/diff", 1))).toBe("gone");
    expect(at(stepDifference(rows, "gone", 1))).toBe(null);
    expect(at(stepDifference(rows, null, -1))).toBe("gone");
    expect(at(stepDifference(rows, "gone", -1))).toBe("a/diff");
    expect(ancestorsOf(rows, "a/diff")).toEqual(["a"]);
  });
});

describe("exclude patterns", () => {
  it("matches names with wildcards, ignoring case", () => {
    expect(globMatch(".git", ".git")).toBe(true);
    expect(globMatch(".git", "agit")).toBe(false);
    expect(globMatch("*.log", "Build.LOG")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "ac")).toBe(false);
    expect(globMatch("(x)", "(x)")).toBe(true);
  });

  it("splits the exclude box", () => {
    expect(parseExclude(" .git, node_modules;*.tmp ,")).toEqual([".git", "node_modules", "*.tmp"]);
  });
});

describe("planSync", () => {
  // a.txt: left newer and bigger. b.txt: right newer. c.txt: same size, not compared yet.
  // lonly/ and ronly.txt on one side; "x" a file on the left and a folder on the right.
  const left = [file("a.txt", 2, 9000), file("b.txt", 1, 1000), file("c.txt", 4), dir("lonly", [file("in.txt", 1)]), file("same.txt", 0), file("x", 1)];
  const right = [file("a.txt", 1, 1000), file("b.txt", 3, 9000), file("c.txt", 4), file("ronly.txt", 1), file("same.txt", 0), dir("x", [])];
  const tree = compareTrees(left, right, "content", none);
  const show = (p: ReturnType<typeof planSync>) =>
    p.actions.map((a) => (a.op === "copy" ? `${a.from === "left" ? "→" : "←"} ${a.path}` : `✕${a.side === "left" ? "L" : "R"} ${a.path}`));

  it("updates one side without deleting", () => {
    const plan = planSync(tree, "toRight", false);
    expect(show(plan)).toEqual(["→ lonly", "→ a.txt", "→ b.txt"]);
    expect(plan.skipped).toEqual(["c.txt", "x"]);
  });

  it("mirrors, deleting first", () => {
    const plan = planSync(tree, "toLeft", true);
    expect(show(plan)).toEqual(["✕L lonly", "✕L x", "← x", "← a.txt", "← b.txt", "← ronly.txt"]);
    expect(plan.skipped).toEqual(["c.txt"]);
  });

  it("syncs both ways by newer file", () => {
    const plan = planSync(tree, "both", false);
    expect(show(plan)).toEqual(["→ lonly", "→ a.txt", "← b.txt", "← ronly.txt"]);
    expect(plan.skipped).toEqual(["x", "c.txt"]);
  });
});
