import type { OpenedFile } from "./files";

export type EntryKind = "file" | "dir";

/** One file or folder as a host lists it. `modified` is milliseconds since the Unix epoch. */
export interface FolderEntry {
  name: string;
  kind: EntryKind;
  size: number;
  modified?: number | null;
  /** Folder contents; empty for files. */
  children: FolderEntry[];
}

/** A folder picked on one side. `name` is shown to the user; `handle` is host-specific. */
export interface FolderRef {
  name: string;
  handle: unknown;
}

/**
 * Where folders come from; the web and desktop apps each provide one.
 * Paths are relative to the picked folder and use `/`.
 */
export interface FolderHost {
  pick(): Promise<FolderRef | null>;
  /** Reads a folder dropped onto a side. Must start reading before its first `await`. */
  fromDrop?(data: DataTransfer): Promise<FolderRef | null>;
  /** Lists the folder recursively, skipping names that match an `exclude` pattern. */
  scan(folder: FolderRef, exclude: string[]): Promise<FolderEntry[]>;
  read(folder: FolderRef, path: string): Promise<OpenedFile>;
  /** Whether the file at `path` has the same bytes on both sides. */
  sameContent(left: FolderRef, right: FolderRef, path: string): Promise<boolean>;
}

/**
 * `different`: the files differ, or a folder contains a difference. `pending`: same size and
 * the contents haven't been compared yet.
 */
export type Status = "same" | "different" | "leftOnly" | "rightOnly" | "pending" | "error";

/** `content` compares bytes; `quick` trusts size and modified time. */
export type Criteria = "content" | "quick";

export type Verdict = "same" | "different" | "error";

/**
 * Content comparison results by path. `sig` records the sizes and times that were compared,
 * so a result is reused after a rescan only while neither file has changed.
 */
export type Verdicts = ReadonlyMap<string, { result: Verdict; sig: string }>;

/** What a content verdict depends on. */
export const signature = (l: FolderEntry, r: FolderEntry) => `${l.size}:${l.modified ?? ""}|${r.size}:${r.modified ?? ""}`;

export interface FolderNode {
  /** Unique: the path, plus the side when a file and a folder share a name. */
  key: string;
  path: string;
  name: string;
  kind: EntryKind;
  left?: FolderEntry;
  right?: FolderEntry;
  status: Status;
  /** The side with the later modified time, for files present on both sides. */
  newer?: "left" | "right";
  children: FolderNode[];
}

/** FAT and some network drives keep times to 2 seconds. */
const TIME_TOLERANCE_MS = 2000;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byKindThenName = (a: FolderNode, b: FolderNode) =>
  a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Matches the two trees by name (case-sensitive) and gives every entry a status. */
export function compareTrees(left: FolderEntry[], right: FolderEntry[], criteria: Criteria, verdicts: Verdicts, base = ""): FolderNode[] {
  const rightByName = new Map(right.map((e) => [e.name, e]));
  const leftNames = new Set(left.map((e) => e.name));
  const nodes: FolderNode[] = [];
  for (const l of left) {
    const r = rightByName.get(l.name);
    if (r && r.kind === l.kind) nodes.push(pair(l, r, criteria, verdicts, base));
    else {
      nodes.push(single(l, "left", base, !!r));
      if (r) nodes.push(single(r, "right", base, true));
    }
  }
  for (const r of right) if (!leftNames.has(r.name)) nodes.push(single(r, "right", base, false));
  return nodes.sort(byKindThenName);
}

const join = (base: string, name: string) => (base ? `${base}/${name}` : name);

function pair(l: FolderEntry, r: FolderEntry, criteria: Criteria, verdicts: Verdicts, base: string): FolderNode {
  const path = join(base, l.name);
  const node: FolderNode = { key: path, path, name: l.name, kind: l.kind, left: l, right: r, status: "same", children: [] };
  if (l.kind === "dir") {
    node.children = compareTrees(l.children, r.children, criteria, verdicts, path);
    node.status = folderStatus(node.children);
    return node;
  }
  const v = verdicts.get(path);
  node.status = fileStatus(l, r, criteria, v && v.sig === signature(l, r) ? v.result : undefined);
  if (node.status !== "same" && l.modified != null && r.modified != null && Math.abs(l.modified - r.modified) > TIME_TOLERANCE_MS) {
    node.newer = l.modified > r.modified ? "left" : "right";
  }
  return node;
}

function fileStatus(l: FolderEntry, r: FolderEntry, criteria: Criteria, verdict: Verdict | undefined): Status {
  if (l.size !== r.size) return "different";
  if (criteria === "quick" && l.modified != null && r.modified != null) {
    return Math.abs(l.modified - r.modified) <= TIME_TOLERANCE_MS ? "same" : "different";
  }
  if (l.size === 0) return "same";
  return verdict ?? "pending";
}

function folderStatus(children: FolderNode[]): Status {
  let pending = false;
  for (const c of children) {
    if (c.status === "pending") pending = true;
    else if (c.status !== "same") return "different";
  }
  return pending ? "pending" : "same";
}

/** An entry on one side only, with all of its contents. `clash`: the other side has the name as the other kind. */
function single(e: FolderEntry, side: "left" | "right", base: string, clash: boolean): FolderNode {
  const path = join(base, e.name);
  const status: Status = side === "left" ? "leftOnly" : "rightOnly";
  return {
    key: clash ? `${path}#${side}` : path,
    path,
    name: e.name,
    kind: e.kind,
    [side]: e,
    status,
    children: e.children.map((c) => single(c, side, path, false)).sort(byKindThenName),
  };
}

/** The files whose contents still need comparing. */
export function pendingFiles(nodes: FolderNode[], out: FolderNode[] = []): FolderNode[] {
  for (const n of nodes) {
    if (n.kind === "file" && n.status === "pending") out.push(n);
    else if (n.status === "pending" || n.status === "different") pendingFiles(n.children, out);
  }
  return out;
}

export type FileCounts = Record<Status, number>;

/** How many files have each status; folders aren't counted. */
export function countFiles(nodes: FolderNode[], counts: FileCounts = { same: 0, different: 0, leftOnly: 0, rightOnly: 0, pending: 0, error: 0 }): FileCounts {
  for (const n of nodes) {
    if (n.kind === "file") counts[n.status]++;
    else countFiles(n.children, counts);
  }
  return counts;
}

/** `diff`: anything not the same. `orphans`: entries on one side only. */
export type Filter = "all" | "diff" | "same" | "orphans";

const shows = (n: FolderNode, filter: Filter) =>
  filter === "all" ||
  (filter === "same" ? n.status === "same" : filter === "orphans" ? n.status === "leftOnly" || n.status === "rightOnly" : n.status !== "same");

/** Drops what the filter hides; a folder stays when it matches itself or keeps any children. */
export function filterTree(nodes: FolderNode[], filter: Filter): FolderNode[] {
  if (filter === "all") return nodes;
  const out: FolderNode[] = [];
  for (const n of nodes) {
    if (n.kind === "file") {
      if (shows(n, filter)) out.push(n);
      continue;
    }
    const children = filterTree(n.children, filter);
    if (children.length || (shows(n, filter) && (filter !== "same" || n.children.length === 0))) out.push({ ...n, children });
  }
  return out;
}

export interface Row {
  node: FolderNode;
  depth: number;
  parent: string | null;
}

/** The rows on screen: every node whose ancestors are all expanded. */
export function visibleRows(nodes: FolderNode[], expanded: ReadonlySet<string>): Row[] {
  return flatten(nodes, (key) => expanded.has(key), 0, null, []);
}

/** Every row as if all folders were expanded, for moving between differences. */
export function allRows(nodes: FolderNode[]): Row[] {
  return flatten(nodes, () => true, 0, null, []);
}

function flatten(nodes: FolderNode[], open: (key: string) => boolean, depth: number, parent: string | null, out: Row[]): Row[] {
  for (const node of nodes) {
    out.push({ node, depth, parent });
    if (node.kind === "dir" && open(node.key)) flatten(node.children, open, depth + 1, node.key, out);
  }
  return out;
}

/** Keys of all folders, for "expand all". */
export function folderKeys(nodes: FolderNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "dir") {
      out.push(n.key);
      folderKeys(n.children, out);
    }
  }
  return out;
}

const isStop = (n: FolderNode) => n.status === "different" || n.status === "leftOnly" || n.status === "rightOnly" || n.status === "error";

/**
 * The next difference after `from` (or before it, `dir` -1): a differing file, or a whole
 * folder that exists on one side only. Returns the row index in `rows`, or -1.
 */
export function stepDifference(rows: Row[], from: string | null, dir: 1 | -1): number {
  const start = from === null ? -1 : rows.findIndex((r) => r.node.key === from);
  const status = new Map(rows.map((r) => [r.node.key, r.node.status]));
  // Everything inside a one-sided folder is one-sided too, so checking the parent is enough.
  const insideOrphan = (r: Row) => {
    const p = r.parent === null ? undefined : status.get(r.parent);
    return p === "leftOnly" || p === "rightOnly";
  };
  const begin = start < 0 ? (dir === 1 ? 0 : rows.length - 1) : start + dir;
  for (let i = begin; i >= 0 && i < rows.length; i += dir) {
    const n = rows[i].node;
    if ((n.kind === "file" || n.status === "leftOnly" || n.status === "rightOnly") && isStop(n) && !insideOrphan(rows[i])) return i;
  }
  return -1;
}

/** Keys of the folders containing `key`, outermost first. */
export function ancestorsOf(rows: Row[], key: string): string[] {
  const parents = new Map(rows.map((r) => [r.node.key, r.parent]));
  const out: string[] = [];
  for (let p = parents.get(key) ?? null; p !== null; p = parents.get(p) ?? null) out.unshift(p);
  return out;
}

/** `*` matches any run of characters and `?` one character; letters ignore case. Same rule as the desktop scanner. */
export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    "is",
  );
  return re.test(name);
}

/** Splits the exclude box ("a, b; c") into patterns. */
export function parseExclude(text: string): string[] {
  return text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}
