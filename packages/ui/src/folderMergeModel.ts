import { signature, type Criteria, type EntryKind, type FolderEntry, type Verdict } from "./folderTree";

/** The three folders of a folder merge. */
export type MergePart = "left" | "base" | "right";
export const PARTS: MergePart[] = ["left", "base", "right"];

/** What one side did to an entry, relative to the base. `unknown`: contents not compared yet; `error`: couldn't be read. */
export type Change = "none" | "added" | "deleted" | "modified" | "unknown" | "error";

/**
 * `same`: neither side changed it. `left`/`right`: only that side did. `both`: both made the same
 * change. `conflict`: they changed it differently. `mixed`: a folder with changes from both sides
 * but no conflict. `pending`: not compared yet.
 */
export type MergeStatus = "same" | "left" | "right" | "both" | "conflict" | "mixed" | "pending" | "error";

/**
 * Where an entry's result comes from: one of the three folders (a folder the entry is missing
 * from means "delete"), `merge` for a line-by-line merge of a text file, or `manual` when the
 * user merged the file by hand and it is already in the result folder.
 */
export type Decision = MergePart | "merge" | "manual";

export interface MergeNode {
  key: string;
  path: string;
  name: string;
  kind: EntryKind;
  left?: FolderEntry;
  base?: FolderEntry;
  right?: FolderEntry;
  leftChange: Change;
  rightChange: Change;
  status: MergeStatus;
  /** The entry has different kinds (file and folder) in different folders. */
  clash: boolean;
  children: MergeNode[];
}

/** Which two folders a content comparison was between. */
export type Pair = "LB" | "RB" | "LR";

/** Content comparison results by `pairKey(path, pair)`, keyed to the sizes and times compared. */
export type MergeVerdicts = ReadonlyMap<string, { result: Verdict; sig: string }>;
export const pairKey = (path: string, pair: Pair) => `${pair}:${path}`;

const PAIR_PARTS: Record<Pair, [MergePart, MergePart]> = { LB: ["left", "base"], RB: ["right", "base"], LR: ["left", "right"] };

const TIME_TOLERANCE_MS = 2000;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const join = (base: string, name: string) => (base ? `${base}/${name}` : name);

type Lists = Partial<Record<MergePart, FolderEntry[]>>;

/** Whether two files have the same contents: true, false, or undefined when not known yet. */
function equal(a: FolderEntry, b: FolderEntry, path: string, pair: Pair, criteria: Criteria, verdicts: MergeVerdicts): boolean | undefined | "error" {
  if (a.size !== b.size) return false;
  if (criteria === "quick" && a.modified != null && b.modified != null) return Math.abs(a.modified - b.modified) <= TIME_TOLERANCE_MS;
  if (a.size === 0) return true;
  const v = verdicts.get(pairKey(path, pair));
  if (!v || v.sig !== signature(a, b)) return undefined;
  return v.result === "error" ? "error" : v.result === "same";
}

/** Matches the three trees by name and decides what each side did to every entry. */
export function mergeTrees(lists: Lists, criteria: Criteria, verdicts: MergeVerdicts, base = ""): MergeNode[] {
  const names = new Set<string>();
  for (const part of PARTS) for (const e of lists[part] ?? []) names.add(e.name);
  const nodes: MergeNode[] = [];
  for (const name of names) {
    const entries: Partial<Record<MergePart, FolderEntry>> = {};
    for (const part of PARTS) {
      const e = lists[part]?.find((x) => x.name === name);
      if (e) entries[part] = e;
    }
    nodes.push(node(name, entries, criteria, verdicts, base));
  }
  return nodes.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1)));
}

function node(name: string, e: Partial<Record<MergePart, FolderEntry>>, criteria: Criteria, verdicts: MergeVerdicts, base: string): MergeNode {
  const path = join(base, name);
  const present = PARTS.filter((p) => e[p]);
  const kinds = new Set(present.map((p) => e[p]!.kind));
  const clash = kinds.size > 1;
  const kind: EntryKind = kinds.has("dir") && !clash ? "dir" : "file";
  const out: MergeNode = { key: path, path, name, kind, ...e, leftChange: "none", rightChange: "none", status: "same", clash, children: [] };

  if (clash) {
    out.leftChange = sideChange(e.base, e.left, () => e.base!.kind === e.left!.kind ? true : false);
    out.rightChange = sideChange(e.base, e.right, () => e.base!.kind === e.right!.kind ? true : false);
    out.status = "conflict";
    return out;
  }

  if (kind === "dir") {
    const kids = (p: MergePart) => e[p]?.children;
    out.children = mergeTrees({ left: kids("left"), base: kids("base"), right: kids("right") }, criteria, verdicts, path);
    // A folder one side removed or added counts as that change even when it is empty.
    out.leftChange = !e.base && e.left ? "added" : e.base && !e.left ? "deleted" : "none";
    out.rightChange = !e.base && e.right ? "added" : e.base && !e.right ? "deleted" : "none";
    out.status = folderStatus(out);
    return out;
  }

  const eq = (pair: Pair) => {
    const [a, b] = PAIR_PARTS[pair];
    return equal(e[a]!, e[b]!, path, pair, criteria, verdicts);
  };
  out.leftChange = sideChange(e.base, e.left, () => eq("LB"));
  out.rightChange = sideChange(e.base, e.right, () => eq("RB"));
  out.status = fileStatus(out, () => eq("LR"));
  return out;
}

function sideChange(base: FolderEntry | undefined, side: FolderEntry | undefined, same: () => boolean | undefined | "error"): Change {
  if (!base && !side) return "none";
  if (!base) return "added";
  if (!side) return "deleted";
  const s = same();
  return s === undefined ? "unknown" : s === "error" ? "error" : s ? "none" : "modified";
}

function fileStatus(n: MergeNode, sameLR: () => boolean | undefined | "error"): MergeStatus {
  const { leftChange: l, rightChange: r } = n;
  if (l === "error" || r === "error") return "error";
  if (l === "unknown" || r === "unknown") return "pending";
  if (l === "none" && r === "none") return "same";
  if (r === "none") return "left";
  if (l === "none") return "right";
  if (l === "deleted" && r === "deleted") return "both";
  if (l === "deleted" || r === "deleted") return "conflict";
  const s = sameLR();
  if (s === "error") return "error";
  if (s === undefined) return "pending";
  return s ? "both" : "conflict";
}

function folderStatus(n: MergeNode): MergeStatus {
  const seen = new Set<MergeStatus>();
  for (const c of n.children) seen.add(c.status);
  // An empty folder added or removed on one side still is that side's change.
  if (!n.children.length) {
    if (n.leftChange !== "none" && n.rightChange !== "none") return "both";
    return n.leftChange !== "none" ? "left" : n.rightChange !== "none" ? "right" : "same";
  }
  for (const s of ["error", "conflict", "pending"] as const) if (seen.has(s)) return s;
  seen.delete("same");
  if (seen.size === 0) return "same";
  if (seen.size === 1) return [...seen][0];
  return seen.has("left") || seen.has("right") || seen.has("mixed") ? "mixed" : "both";
}

/** File comparisons still needed: [path, pair, entries] for each unknown pair. */
export function pendingComparisons(nodes: MergeNode[], out: { path: string; pair: Pair; sig: string }[] = []): { path: string; pair: Pair; sig: string }[] {
  for (const n of nodes) {
    if (n.kind === "dir") {
      pendingComparisons(n.children, out);
      continue;
    }
    if (n.status !== "pending" || n.clash) continue;
    const add = (pair: Pair) => {
      const [a, b] = PAIR_PARTS[pair];
      out.push({ path: n.path, pair, sig: signature(n[a]!, n[b]!) });
    };
    if (n.leftChange === "unknown") add("LB");
    if (n.rightChange === "unknown") add("RB");
    // Left and right only matter once both are known to have changed the file.
    if (n.leftChange === "modified" && n.rightChange === "modified") add("LR");
    if (n.leftChange === "added" && n.rightChange === "added") add("LR");
  }
  return out;
}

/** The folders each part of a pair names, for running a comparison. */
export const pairParts = (pair: Pair) => PAIR_PARTS[pair];

/** What happens to an entry when nobody picks: take the side that changed it. Conflicts wait for a choice. */
export function defaultDecision(n: MergeNode): Decision | null {
  switch (n.status) {
    case "same":
      return n.left ? "left" : n.right ? "right" : "base";
    case "left":
    case "both":
      return "left";
    case "right":
      return "right";
    default:
      return null;
  }
}

/** The decision for a file: the user's pick, else the default. */
export const decisionOf = (n: MergeNode, picks: ReadonlyMap<string, Decision>) => picks.get(n.key) ?? defaultDecision(n);

/** Which choices make sense for an entry. */
export function choicesFor(n: MergeNode): Decision[] {
  const out: Decision[] = ["left", "right", "base"];
  const textMerge = !n.clash && n.kind === "file" && !!n.left && !!n.right;
  if (textMerge) out.push("merge");
  return out;
}

/** Every file and empty folder below (and including) `nodes`: the entries a decision applies to. */
export function leavesOf(nodes: MergeNode[], out: MergeNode[] = []): MergeNode[] {
  for (const n of nodes) {
    if (n.kind === "file" || !n.children.length) out.push(n);
    else leavesOf(n.children, out);
  }
  return out;
}

/** Every file below (and including) `nodes`, flattened. */
export function filesOf(nodes: MergeNode[], out: MergeNode[] = []): MergeNode[] {
  for (const n of nodes) {
    if (n.kind === "file") out.push(n);
    else filesOf(n.children, out);
  }
  return out;
}

export type MergeCounts = Record<MergeStatus, number> & { undecided: number };

/** Counts files by status, plus conflicts nobody has decided yet. */
export function countMerge(nodes: MergeNode[], picks: ReadonlyMap<string, Decision>): MergeCounts {
  const counts: MergeCounts = { same: 0, left: 0, right: 0, both: 0, conflict: 0, mixed: 0, pending: 0, error: 0, undecided: 0 };
  const walk = (list: MergeNode[]) => {
    for (const n of list) {
      if (n.kind === "dir") {
        // Empty folders a side added or removed are changes of their own.
        if (!n.children.length && n.status !== "same") counts[n.status]++;
        walk(n.children);
        continue;
      }
      counts[n.status]++;
      if (decisionOf(n, picks) === null) counts.undecided++;
    }
  };
  walk(nodes);
  return counts;
}

/** Where the result is written: into the left or right folder itself, or a separate folder. */
export type Output = "left" | "right" | "other";

/** One step of applying a merge to the result folder. */
export type MergeAction =
  | { op: "copy"; from: MergePart; path: string; kind: EntryKind }
  | { op: "remove"; path: string; kind: EntryKind }
  | { op: "merge"; path: string };

/**
 * The steps that turn the result folder into the merge. With `left` or `right` as the output,
 * only what differs from that folder is touched; with `other`, every entry is copied in.
 * Folders whose whole contents come from one side are copied or removed in one step.
 */
export function planMerge(nodes: MergeNode[], picks: ReadonlyMap<string, Decision>, output: Output): { actions: MergeAction[]; undecided: string[] } {
  const removes: MergeAction[] = [];
  const writes: MergeAction[] = [];
  const undecided: string[] = [];
  const has = (n: MergeNode, part: MergePart) => !!n[part];
  const outHas = (n: MergeNode) => output !== "other" && has(n, output);

  /** The single source every file below `n` takes, if there is one. */
  const soleSource = (n: MergeNode): MergePart | null | undefined => {
    let source: MergePart | null | undefined;
    for (const f of leavesOf(n.children)) {
      const d = decisionOf(f, picks);
      if (d === null || d === "merge" || d === "manual") return null;
      if (source === undefined) source = d;
      else if (source !== d) return null;
    }
    return source;
  };

  const walk = (list: MergeNode[]) => {
    for (const n of list) {
      if (n.kind === "dir" && !n.clash) {
        const source = soleSource(n) ?? (n.children.length ? null : decisionOf(n, picks));
        if (source && source !== "merge" && source !== "manual") {
          if (output === source) continue;
          if (!has(n, source)) {
            if (outHas(n)) removes.push({ op: "remove", path: n.path, kind: "dir" });
            continue;
          }
          if (!outHas(n)) {
            writes.push({ op: "copy", from: source, path: n.path, kind: "dir" });
            continue;
          }
        }
        walk(n.children);
        continue;
      }
      const d = decisionOf(n, picks);
      if (d === null) {
        undecided.push(n.path);
        continue;
      }
      if (d === "manual" || d === output) continue;
      if (d === "merge") {
        writes.push({ op: "merge", path: n.path });
        continue;
      }
      const src = n[d];
      if (!src) {
        if (outHas(n)) removes.push({ op: "remove", path: n.path, kind: n.clash ? (n[output as MergePart]?.kind ?? "file") : n.kind });
        continue;
      }
      // A file replacing a folder (or the reverse) needs the old entry out of the way first.
      const old = output !== "other" ? n[output] : undefined;
      if (old && old.kind !== src.kind) removes.push({ op: "remove", path: n.path, kind: old.kind });
      writes.push({ op: "copy", from: d, path: n.path, kind: src.kind });
    }
  };
  walk(nodes);
  return { actions: [...removes, ...writes], undecided };
}

export type MergeFilter = "all" | "changes" | "conflicts";

/** The entries a view shows: everything, what either side changed, or just the conflicts. */
export function filterMerge(nodes: MergeNode[], filter: MergeFilter): MergeNode[] {
  if (filter === "all") return nodes;
  const keep = (n: MergeNode) => (filter === "changes" ? n.status !== "same" : n.status === "conflict" || n.status === "error");
  const out: MergeNode[] = [];
  for (const n of nodes) {
    if (!keep(n)) continue;
    out.push(n.kind === "dir" ? { ...n, children: filterMerge(n.children, filter) } : n);
  }
  return out;
}

export interface MergeRow {
  node: MergeNode;
  depth: number;
  parent: string | null;
}

/** The rows on screen (`open` decides which folders are expanded), or every row. */
export function mergeRows(nodes: MergeNode[], open: (key: string) => boolean = () => true, depth = 0, parent: string | null = null, out: MergeRow[] = []): MergeRow[] {
  for (const node of nodes) {
    out.push({ node, depth, parent });
    if (node.kind === "dir" && open(node.key)) mergeRows(node.children, open, depth + 1, node.key, out);
  }
  return out;
}

/** Keys of all folders, for "expand all". */
export function mergeFolderKeys(nodes: MergeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "dir") {
      out.push(n.key);
      mergeFolderKeys(n.children, out);
    }
  }
  return out;
}

/**
 * The next entry that still needs a decision after `from` (before it when `dir` is -1), going
 * through every row as if all folders were open. Returns its index in `rows`, or -1.
 */
export function stepUndecided(rows: MergeRow[], from: string | null, dir: 1 | -1, picks: ReadonlyMap<string, Decision>): number {
  const start = from === null ? -1 : rows.findIndex((r) => r.node.key === from);
  const begin = start < 0 ? (dir === 1 ? 0 : rows.length - 1) : start + dir;
  for (let i = begin; i >= 0 && i < rows.length; i += dir) {
    const n = rows[i].node;
    if ((n.kind === "file" || !n.children.length) && (n.status === "conflict" || n.status === "error") && decisionOf(n, picks) === null) return i;
  }
  return -1;
}

/** The parent folders of the row with `key`, outermost first. */
export function mergeAncestors(rows: MergeRow[], key: string): string[] {
  const parents = new Map(rows.map((r) => [r.node.key, r.parent]));
  const out: string[] = [];
  for (let p = parents.get(key) ?? null; p !== null; p = parents.get(p) ?? null) out.unshift(p);
  return out;
}

/**
 * The decision a folder shows: the one all its entries share, `null` while any is undecided,
 * or "mixed" when they differ.
 */
export function folderDecision(n: MergeNode, picks: ReadonlyMap<string, Decision>): Decision | null | "mixed" {
  let shared: Decision | null | undefined;
  for (const f of leavesOf(n.children)) {
    const d = decisionOf(f, picks);
    if (d === null) return null;
    if (shared === undefined) shared = d;
    else if (shared !== d) return "mixed";
  }
  return shared ?? decisionOf(n, picks);
}

/** Picks `decision` for every entry below the folder `n` (or `n` itself), where it makes sense. */
export function pickAll(n: MergeNode, decision: Decision, picks: ReadonlyMap<string, Decision>): Map<string, Decision> {
  const next = new Map(picks);
  for (const f of n.kind === "dir" && n.children.length ? leavesOf(n.children) : [n]) {
    if (choicesFor(f).includes(decision)) next.set(f.key, decision);
  }
  return next;
}
