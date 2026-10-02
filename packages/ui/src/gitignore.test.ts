import { describe, expect, it } from "vitest";
import { applyGitignore, isIgnored, parseGitignore } from "./gitignore";
import type { FolderEntry } from "./folderTree";

const file = (name: string): FolderEntry => ({ name, kind: "file", size: 1, children: [] });
const dir = (name: string, children: FolderEntry[]): FolderEntry => ({ name, kind: "dir", size: 0, children });

describe("gitignore rules", () => {
  const rules = parseGitignore(
    ["# comment", "", "*.log", "!keep.log", "build/", "/root-only.txt", "docs/**/*.tmp", "a/**/b", "\\#hash", "file?.c", "[ab]x"].join("\n"),
    "",
  );
  const ignored = (path: string, isDir = false) => isIgnored(rules, path, isDir);

  it("matches names at any depth unless the pattern has a slash", () => {
    expect(ignored("x.log")).toBe(true);
    expect(ignored("deep/in/x.log")).toBe(true);
    expect(ignored("deep/keep.log")).toBe(false);
    expect(ignored("root-only.txt")).toBe(true);
    expect(ignored("sub/root-only.txt")).toBe(false);
  });

  it("handles folders only, ** and character classes", () => {
    expect(ignored("build", true)).toBe(true);
    expect(ignored("src/build", true)).toBe(true);
    expect(ignored("build")).toBe(false);
    expect(ignored("docs/x.tmp")).toBe(true);
    expect(ignored("docs/a/b/x.tmp")).toBe(true);
    expect(ignored("other/x.tmp")).toBe(false);
    expect(ignored("a/b")).toBe(true);
    expect(ignored("a/x/y/b")).toBe(true);
    expect(ignored("#hash")).toBe(true);
    expect(ignored("file1.c")).toBe(true);
    expect(ignored("file10.c")).toBe(false);
    expect(ignored("bx")).toBe(true);
    expect(ignored("cx")).toBe(false);
  });

  it("scopes nested .gitignore files to their folder", () => {
    const nested = parseGitignore("/only-here\n*.bak", "pkg");
    expect(isIgnored(nested, "pkg/only-here", false)).toBe(true);
    expect(isIgnored(nested, "only-here", false)).toBe(false);
    expect(isIgnored(nested, "pkg/sub/a.bak", false)).toBe(true);
    expect(isIgnored(nested, "a.bak", false)).toBe(false);
  });
});

describe("applyGitignore", () => {
  it("filters the tree using every .gitignore in it", async () => {
    const tree = [file(".gitignore"), file("a.log"), file("main.rs"), dir("target", [file("out")]), dir("pkg", [file(".gitignore"), file("x.tmp"), file("y.rs")])];
    const texts: Record<string, string> = { ".gitignore": "*.log\ntarget/", "pkg/.gitignore": "*.tmp" };
    const out = await applyGitignore(tree, async (p) => texts[p]);
    const names = (list: FolderEntry[], base = ""): string[] =>
      list.flatMap((e) => [base + e.name, ...(e.kind === "dir" ? names(e.children, `${base}${e.name}/`) : [])]);
    expect(names(out)).toEqual([".gitignore", "main.rs", "pkg", "pkg/.gitignore", "pkg/y.rs"]);
  });
});
