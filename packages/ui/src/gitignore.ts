import type { FolderEntry } from "./folderTree";

/** One line of a `.gitignore`, ready to test against paths below the file's folder. */
export interface GitignoreRule {
  /** Folder of the `.gitignore`, relative to the compared root ("" for the root). */
  base: string;
  negate: boolean;
  dirOnly: boolean;
  /** Matched against the whole path below `base` when anchored, otherwise against the name. */
  anchored: boolean;
  re: RegExp;
}

/** Turns a gitignore glob into a regular expression source (no anchors). */
function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length || glob[i + 2] === "/";
        if (atStart && atEnd) {
          // "**/" matches zero or more folders; a final "**" matches everything inside.
          if (i + 2 === glob.length) out += ".*";
          else out += "(?:.*/)?";
          i += 2;
          continue;
        }
      }
      out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) out += "\\[";
      else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        out += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (c === "\\" && i + 1 < glob.length) {
      out += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else out += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return out;
}

/** Parses a `.gitignore` found in folder `base`. */
export function parseGitignore(text: string, base: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    // Trailing spaces don't count unless escaped.
    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    try {
      rules.push({ base, negate, dirOnly, anchored, re: new RegExp(`^${globSource(line)}$`) });
    } catch {
      // A pattern Git would also struggle with; skip it.
    }
  }
  return rules;
}

/** Whether `path` (relative to the compared root) is ignored. The last matching rule wins. */
export function isIgnored(rules: GitignoreRule[], path: string, isDir: boolean): boolean {
  let ignored = false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && !path.startsWith(r.base + "/")) continue;
    const rel = r.base ? path.slice(r.base.length + 1) : path;
    if (r.re.test(r.anchored ? rel : name)) ignored = !r.negate;
  }
  return ignored;
}

/**
 * Drops what the `.gitignore` files in the tree ignore. Like Git, a file inside an ignored
 * folder stays ignored even if a later rule names it. `read` returns a file's text.
 */
export async function applyGitignore(entries: FolderEntry[], read: (path: string) => Promise<string>): Promise<FolderEntry[]> {
  const walk = async (list: FolderEntry[], base: string, inherited: GitignoreRule[]): Promise<FolderEntry[]> => {
    let rules = inherited;
    if (list.some((e) => e.name === ".gitignore" && e.kind === "file")) {
      const path = base ? `${base}/.gitignore` : ".gitignore";
      try {
        rules = [...inherited, ...parseGitignore(await read(path), base)];
      } catch {
        // An unreadable .gitignore ignores nothing.
      }
    }
    const out: FolderEntry[] = [];
    for (const e of list) {
      const path = base ? `${base}/${e.name}` : e.name;
      if (isIgnored(rules, path, e.kind === "dir")) continue;
      out.push(e.kind === "dir" ? { ...e, children: await walk(e.children, path, rules) } : e);
    }
    return out;
  };
  return walk(entries, "", []);
}
