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
  /**
   * Regular expressions for text that doesn't matter, such as comments. Matches are removed from
   * each line before comparing; a change made only of lines left blank by that is unimportant.
   */
  ignore: string[];
  /** Also treat changes that only add or remove blank lines as unimportant. */
  ignoreBlankLines: boolean;
}

export const defaultOptions: DiffOptions = {
  whitespace: "exact",
  ignoreCase: false,
  ignoreLineEndings: true,
  algorithm: "histogram",
  inline: "word",
  ignore: [],
  ignoreBlankLines: false,
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
  /** Only lines the ignore rules say don't matter; not counted in `DiffStats` except `unimportant`. */
  unimportant: boolean;
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
  /** Changes that matter. */
  changes: number;
  /** Changes made only of ignored text. */
  unimportant: number;
}

export interface TextDiff {
  chunks: Chunk[];
  pairs: LinePair[];
  stats: DiffStats;
  /** Ignore patterns that aren't valid regular expressions; they were skipped. */
  invalidPatterns: { pattern: string; message: string }[];
}

/** `aligned` compares byte N with byte N; `smart` also finds inserted and deleted bytes. */
export type BinaryMode = "aligned" | "smart";

export interface BinaryOptions {
  mode: BinaryMode;
}

/** A run of bytes with the same status; ranges are byte offsets. Chunks cover both inputs in order. */
export interface ByteChunk {
  kind: ChunkKind;
  left: Span;
  right: Span;
}

export interface BinaryStats {
  leftLen: number;
  rightLen: number;
  changes: number;
  changed: number;
  inserted: number;
  deleted: number;
}

export interface BinaryDiff {
  chunks: ByteChunk[];
  stats: BinaryStats;
  /** The mode actually used: very large inputs fall back to `aligned`. */
  mode: BinaryMode;
}

/**
 * How a run of lines merges. `left`/`right`: only that side changed them. `both`: both made
 * the same change. `conflict`: both changed them differently.
 */
export type RegionKind = "unchanged" | "left" | "right" | "both" | "conflict";

/** Line ranges (0-based) in each text; regions cover all three texts in order. */
export interface MergeRegion {
  kind: RegionKind;
  base: Span;
  left: Span;
  right: Span;
}

export interface MergeStats {
  leftChanges: number;
  rightChanges: number;
  bothChanges: number;
  conflicts: number;
}

export interface Merge3 {
  regions: MergeRegion[];
  stats: MergeStats;
}

/** The diff engine: WebAssembly in the browser, native Rust in the desktop app. */
export interface DiffEngine {
  diffText(left: string, right: string, options?: Partial<DiffOptions>): Promise<TextDiff>;
  diffBytes(left: Uint8Array, right: Uint8Array, options?: Partial<BinaryOptions>): Promise<BinaryDiff>;
  merge3(base: string, left: string, right: string, options?: Partial<DiffOptions>): Promise<Merge3>;
}
