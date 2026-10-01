import type { BinaryDiff, ChunkKind } from "@bigyo/engine";

export const BYTES_PER_ROW = 16;

/**
 * The hex view shows both sides as one sequence of aligned cells: an equal or replaced byte
 * occupies a cell on both sides, an inserted or deleted byte leaves a gap on the other side.
 */
export interface HexLayout {
  /** First cell of each chunk. */
  cellStart: number[];
  totalCells: number;
  rows: number;
}

export interface HexCell {
  /** Byte offset on each side, or null where that side has no byte. */
  left: number | null;
  right: number | null;
  kind: ChunkKind;
  chunk: number;
}

const len = (s: { start: number; end: number }) => s.end - s.start;

export function hexLayout(diff: BinaryDiff): HexLayout {
  const cellStart: number[] = [];
  let total = 0;
  for (const c of diff.chunks) {
    cellStart.push(total);
    total += Math.max(len(c.left), len(c.right));
  }
  return { cellStart, totalCells: total, rows: Math.ceil(total / BYTES_PER_ROW) };
}

/** Index of the chunk containing cell `cell` (binary search). */
export function chunkAtCell(layout: HexLayout, cell: number): number {
  let lo = 0;
  let hi = layout.cellStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.cellStart[mid] <= cell) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The cells of one row, starting the chunk search at the row's first cell. */
export function rowCells(diff: BinaryDiff, layout: HexLayout, row: number): HexCell[] {
  const first = row * BYTES_PER_ROW;
  const last = Math.min(first + BYTES_PER_ROW, layout.totalCells);
  const out: HexCell[] = [];
  let chunk = chunkAtCell(layout, first);
  for (let cell = first; cell < last; cell++) {
    while (chunk + 1 < layout.cellStart.length && layout.cellStart[chunk + 1] <= cell) chunk++;
    const c = diff.chunks[chunk];
    const i = cell - layout.cellStart[chunk];
    out.push({
      left: i < len(c.left) ? c.left.start + i : null,
      right: i < len(c.right) ? c.right.start + i : null,
      kind: c.kind,
      chunk,
    });
  }
  return out;
}

export const rowOfChunk = (layout: HexLayout, chunk: number) => Math.floor((layout.cellStart[chunk] ?? 0) / BYTES_PER_ROW);

export const hexByte = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
export const asciiChar = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".");
export const hexOffset = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");
