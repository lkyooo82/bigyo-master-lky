import type { ChunkKind, Span } from "@bigyo/engine";

/** The part of a text or byte diff that navigation needs. */
export interface ChunkList {
  chunks: { kind: ChunkKind; left: Span; right: Span }[];
}
type Chunk = ChunkList["chunks"][number];

/** Indices of the chunks that are differences, in document order. */
export function changeIndices(diff: ChunkList | null): number[] {
  if (!diff) return [];
  const out: number[] = [];
  diff.chunks.forEach((c, i) => c.kind !== "equal" && out.push(i));
  return out;
}

/** The next (dir = 1) or previous (dir = -1) difference after chunk `current`, or -1. */
export function stepChange(changes: number[], current: number, dir: 1 | -1): number {
  if (changes.length === 0) return -1;
  if (dir === 1) return changes.find((i) => i > current) ?? changes[changes.length - 1];
  for (let k = changes.length - 1; k >= 0; k--) if (changes[k] < current) return changes[k];
  return changes[0];
}

export interface OverviewMark {
  chunk: number;
  kind: ChunkKind;
  /** Position and size as fractions of the aligned document height. */
  top: number;
  height: number;
}

const rows = (c: Chunk) => Math.max(c.left.end - c.left.start, c.right.end - c.right.start);

/** Where each difference sits in the aligned view, for the overview bar. */
/** The overview bar is a few hundred pixels tall; more marks than this only cost rendering time. */
const MAX_MARKS = 500;

export function overviewMarks(diff: ChunkList | null): OverviewMark[] {
  if (!diff) return [];
  const total = diff.chunks.reduce((n, c) => n + rows(c), 0) || 1;
  const minGap = 1 / MAX_MARKS;
  let row = 0;
  const out: OverviewMark[] = [];
  diff.chunks.forEach((c, i) => {
    const h = Math.max(rows(c), 0);
    if (c.kind !== "equal") {
      const top = row / total;
      const last = out[out.length - 1];
      // Marks closer together than one bucket merge into the first one (it stays clickable).
      if (last && top - (last.top + last.height) < minGap) {
        last.height = top + h / total - last.top;
        if (last.kind !== c.kind) last.kind = "replace";
      } else {
        out.push({ chunk: i, kind: c.kind, top, height: h / total });
      }
    }
    row += h;
  });
  return out;
}
