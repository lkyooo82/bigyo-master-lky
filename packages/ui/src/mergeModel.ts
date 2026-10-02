import type { MergeRegion } from "@bigyo/engine";

/** The three inputs of a merge, as the editor shows them (lines split on `\n`). */
export interface MergeInputs {
  base: string;
  left: string;
  right: string;
}

export type Pane = "left" | "base" | "right";
export const PANES: Pane[] = ["left", "base", "right"];

/** Git's diff3 conflict markers, so a result saved with conflicts left in it still works with Git. */
export const MARK = { start: "<<<<<<<", base: "|||||||", sep: "=======", end: ">>>>>>>" } as const;

const slice = (lines: string[], r: { start: number; end: number }) => lines.slice(r.start, r.end);

/**
 * The merge result: every change one side made is applied, and each conflict becomes a block
 * with both versions and the base between Git-style markers, numbered from 1.
 */
export function buildResult(regions: MergeRegion[], inputs: MergeInputs): string {
  const base = inputs.base.split("\n");
  const left = inputs.left.split("\n");
  const right = inputs.right.split("\n");
  const out: string[] = [];
  let conflict = 0;
  for (const r of regions) {
    if (r.kind === "unchanged") out.push(...slice(base, r.base));
    else if (r.kind === "left" || r.kind === "both") out.push(...slice(left, r.left));
    else if (r.kind === "right") out.push(...slice(right, r.right));
    else {
      conflict++;
      out.push(
        `${MARK.start} 왼쪽 (충돌 ${conflict})`,
        ...slice(left, r.left),
        `${MARK.base} 기준`,
        ...slice(base, r.base),
        MARK.sep,
        ...slice(right, r.right),
        `${MARK.end} 오른쪽 (충돌 ${conflict})`,
      );
    }
  }
  return out.join("\n");
}

/** A conflict block still in the result. Lines are 0-based; `end` is the `>>>>>>>` line. */
export interface ConflictBlock {
  start: number;
  end: number;
  /** The number in the marker, linking the block to its region; null if someone removed it. */
  id: number | null;
  left: string[];
  /** Null when the block has no base section (a two-way marker block). */
  base: string[] | null;
  right: string[];
}

const idOf = (line: string) => {
  const m = /\(충돌 (\d+)\)\s*$/.exec(line);
  return m ? Number(m[1]) : null;
};

/** Finds the conflict blocks left in `text`, in order. Incomplete blocks are ignored. */
export function findConflicts(text: string): ConflictBlock[] {
  const lines = text.split("\n");
  const out: ConflictBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(MARK.start)) continue;
    let base = -1;
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.startsWith(MARK.start)) break;
      if (l.startsWith(MARK.base) && sep < 0 && base < 0) base = j;
      else if (l.startsWith(MARK.sep) && l.trimEnd() === MARK.sep && sep < 0) sep = j;
      else if (l.startsWith(MARK.end) && sep >= 0) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    out.push({
      start: i,
      end,
      id: idOf(lines[i]) ?? idOf(lines[end]),
      left: lines.slice(i + 1, base >= 0 ? base : sep),
      base: base >= 0 ? lines.slice(base + 1, sep) : null,
      right: lines.slice(sep + 1, end),
    });
    i = end;
  }
  return out;
}

/** How to settle a conflict. */
export type Choice = "left" | "right" | "base" | "leftRight" | "rightLeft";

export function resolution(block: ConflictBlock, choice: Choice): string[] {
  switch (choice) {
    case "left":
      return block.left;
    case "right":
      return block.right;
    case "base":
      return block.base ?? [];
    case "leftRight":
      return [...block.left, ...block.right];
    case "rightLeft":
      return [...block.right, ...block.left];
  }
}

/**
 * Replaces a block's lines with `lines`, returning the new text. A block that resolves to
 * nothing removes its lines entirely.
 */
export function resolveBlock(text: string, block: ConflictBlock, lines: string[]): string {
  const all = text.split("\n");
  all.splice(block.start, block.end - block.start + 1, ...lines);
  return all.join("\n");
}

/** Line counts each pane needs added after a region so all three panes stay aligned. */
export function alignment(regions: MergeRegion[]): Record<Pane, number>[] {
  return regions.map((r) => {
    const len = { left: r.left.end - r.left.start, base: r.base.end - r.base.start, right: r.right.end - r.right.start };
    const max = Math.max(len.left, len.base, len.right);
    return { left: max - len.left, base: max - len.base, right: max - len.right };
  });
}

/** Whether a region changes what `pane` shows relative to the merge outcome. */
export function touches(region: MergeRegion, pane: Pane): boolean {
  switch (region.kind) {
    case "unchanged":
      return false;
    case "conflict":
      return true;
    case "left":
      return pane !== "right";
    case "right":
      return pane !== "left";
    case "both":
      return true;
  }
}
