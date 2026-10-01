// Types mirror crates/diff-core (serde camelCase). Offsets inside lines are UTF-16 code units.

export type WhitespaceMode = "exact" | "trim" | "collapse" | "ignoreAll";
export type InlineMode = "none" | "word" | "char";
export type Algorithm = "histogram" | "myers" | "myersMinimal";

export interface DiffOptions {
  whitespace: WhitespaceMode;
  ignoreCase: boolean;
  ignoreLineEndings: boolean;
  algorithm: Algorithm;
  inline: InlineMode;
}

export const defaultOptions: DiffOptions = {
  whitespace: "exact",
  ignoreCase: false,
  ignoreLineEndings: true,
  algorithm: "histogram",
  inline: "word",
};

/** Half-open range `[start, end)`. */
export interface Span {
  start: number;
  end: number;
}

export type ChunkKind = "equal" | "insert" | "delete" | "replace";

/** A run of lines with the same status; line ranges are 0-based. Chunks cover both texts in order. */
export interface Chunk {
  kind: ChunkKind;
  left: Span;
  right: Span;
}

export interface LinePair {
  leftLine: number;
  rightLine: number;
  leftRanges: Span[];
  rightRanges: Span[];
}

export interface DiffStats {
  leftLines: number;
  rightLines: number;
  inserted: number;
  deleted: number;
  modified: number;
  changes: number;
}

export interface TextDiff {
  chunks: Chunk[];
  pairs: LinePair[];
  stats: DiffStats;
}

/** The diff engine: WebAssembly in the browser, native Rust in the desktop app. */
export interface DiffEngine {
  diffText(left: string, right: string, options?: Partial<DiffOptions>): Promise<TextDiff>;
}
