//! Bigyo Master diff engine.
//!
//! The same crate runs natively inside the desktop app and as WebAssembly in the browser,
//! so both produce identical results.

#![cfg_attr(test, allow(clippy::single_range_in_vec_init))]

pub mod binary;
#[cfg(feature = "fs")]
pub mod folder;
pub mod inline;
pub mod lines;
pub mod merge;
pub mod options;

use std::ops::Range;

use imara_diff::{Diff, InternedInput};

pub use binary::{diff_bytes, BinaryDiff, BinaryMode, BinaryOptions, ByteChunk};
pub use inline::{inline_diff, InlineDiff};
pub use lines::{split_lines, Keyer, Line, PatternError};
pub use merge::{merge3, Merge3, MergeRegion, MergeStats, RegionKind};
pub use options::{Algorithm, DiffOptions, InlineMode, WhitespaceMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum ChunkKind {
    Equal,
    /// Lines exist only on the right.
    Insert,
    /// Lines exist only on the left.
    Delete,
    /// Lines on the left were replaced by lines on the right.
    Replace,
}

/// A run of lines with the same status. Ranges are 0-based line indices; chunks cover both
/// documents completely and in order.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Chunk {
    pub kind: ChunkKind,
    pub left: Range<u32>,
    pub right: Range<u32>,
    /// A change made only of lines the ignore rules say don't matter. It isn't counted in
    /// `stats` apart from `stats.unimportant`.
    pub unimportant: bool,
}

/// Two lines inside a `Replace` chunk that correspond to each other, with the changed byte
/// ranges inside each line.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LinePair {
    pub left_line: u32,
    pub right_line: u32,
    pub left_ranges: Vec<Range<u32>>,
    pub right_ranges: Vec<Range<u32>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct DiffStats {
    pub left_lines: u32,
    pub right_lines: u32,
    /// Lines only on the right, including unpaired lines of replace chunks.
    pub inserted: u32,
    /// Lines only on the left, including unpaired lines of replace chunks.
    pub deleted: u32,
    /// Paired lines that differ.
    pub modified: u32,
    /// Number of non-equal chunks that matter.
    pub changes: u32,
    /// Number of non-equal chunks the ignore rules say don't matter.
    pub unimportant: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TextDiff {
    pub chunks: Vec<Chunk>,
    pub pairs: Vec<LinePair>,
    pub stats: DiffStats,
    /// Ignore patterns that couldn't be used.
    pub invalid_patterns: Vec<PatternError>,
}

impl TextDiff {
    pub fn is_identical(&self) -> bool {
        self.stats.changes == 0
    }

    /// Converts the byte offsets in `pairs` to UTF-16 code units, the unit JavaScript strings
    /// use. `left` and `right` must be the texts this diff was computed from.
    pub fn convert_offsets_to_utf16(&mut self, left: &str, right: &str) {
        fn convert(line: &str, ranges: &mut [Range<u32>]) {
            if line.is_ascii() {
                return;
            }
            let units = |byte: u32| line[..byte as usize].encode_utf16().count() as u32;
            for r in ranges {
                *r = units(r.start)..units(r.end);
            }
        }
        let (ll, rl) = (split_lines(left), split_lines(right));
        for pair in &mut self.pairs {
            convert(ll[pair.left_line as usize].text, &mut pair.left_ranges);
            convert(rl[pair.right_line as usize].text, &mut pair.right_ranges);
        }
    }
}

/// Replace chunks larger than this (left lines × right lines) pair lines by position instead
/// of by similarity, to keep the cost bounded.
const MAX_ALIGN_CELLS: usize = 10_000;
/// Lines less similar than this are shown as a deletion plus an insertion rather than a modification.
const MIN_PAIR_SIMILARITY: f32 = 0.4;

/// Compares two texts line by line.
pub fn diff_text(left: &str, right: &str, opts: &DiffOptions) -> TextDiff {
    let left_lines = split_lines(left);
    let right_lines = split_lines(right);

    let (keyer, invalid_patterns) = Keyer::new(opts);
    let mut input: InternedInput<String> = InternedInput::default();
    input.update_before(left_lines.iter().map(|l| keyer.key(l)));
    input.update_after(right_lines.iter().map(|l| keyer.key(l)));
    let mut diff = Diff::compute(opts.algorithm.into(), &input);
    diff.postprocess_lines(&input);

    let mut out = TextDiff {
        stats: DiffStats {
            left_lines: left_lines.len() as u32,
            right_lines: right_lines.len() as u32,
            ..Default::default()
        },
        invalid_patterns,
        ..Default::default()
    };
    let ignorable_l: Vec<bool> = left_lines.iter().map(|l| keyer.unimportant(l)).collect();
    let ignorable_r: Vec<bool> = right_lines.iter().map(|l| keyer.unimportant(l)).collect();
    let (mut l, mut r) = (0u32, 0u32);
    for hunk in diff.hunks() {
        if hunk.before.start > l {
            out.chunks.push(Chunk {
                kind: ChunkKind::Equal,
                left: l..hunk.before.start,
                right: r..hunk.after.start,
                unimportant: false,
            });
        }
        // Split ignorable lines at either end of the change into changes of their own, so a
        // comment next to a real edit doesn't make the whole block count.
        let (before, after) = (hunk.before.clone(), hunk.after.clone());
        let lead = |flags: &[bool], r: &Range<u32>| {
            flags[r.start as usize..r.end as usize]
                .iter()
                .take_while(|&&f| f)
                .count() as u32
        };
        let trail = |flags: &[bool], r: &Range<u32>| {
            flags[r.start as usize..r.end as usize]
                .iter()
                .rev()
                .take_while(|&&f| f)
                .count() as u32
        };
        let (ll, lr) = (lead(&ignorable_l, &before), lead(&ignorable_r, &after));
        if ll == before.len() as u32 && lr == after.len() as u32 {
            push_change(
                &mut out,
                &left_lines,
                &right_lines,
                before,
                after,
                true,
                opts,
            );
        } else {
            let core_l = before.start + ll..before.end;
            let core_r = after.start + lr..after.end;
            let (tl, tr) = (trail(&ignorable_l, &core_l), trail(&ignorable_r, &core_r));
            push_change(
                &mut out,
                &left_lines,
                &right_lines,
                before.start..core_l.start,
                after.start..core_r.start,
                true,
                opts,
            );
            push_change(
                &mut out,
                &left_lines,
                &right_lines,
                core_l.start..core_l.end - tl,
                core_r.start..core_r.end - tr,
                false,
                opts,
            );
            push_change(
                &mut out,
                &left_lines,
                &right_lines,
                core_l.end - tl..core_l.end,
                core_r.end - tr..core_r.end,
                true,
                opts,
            );
        }
        l = hunk.before.end;
        r = hunk.after.end;
    }
    if (l as usize) < left_lines.len() {
        out.chunks.push(Chunk {
            kind: ChunkKind::Equal,
            left: l..left_lines.len() as u32,
            right: r..right_lines.len() as u32,
            unimportant: false,
        });
    }
    out
}

/// Adds a change chunk for `left`/`right` and counts it; does nothing when both are empty.
fn push_change(
    out: &mut TextDiff,
    left_lines: &[Line<'_>],
    right_lines: &[Line<'_>],
    left: Range<u32>,
    right: Range<u32>,
    unimportant: bool,
    opts: &DiffOptions,
) {
    let kind = match (left.is_empty(), right.is_empty()) {
        (true, true) => return,
        (true, _) => ChunkKind::Insert,
        (_, true) => ChunkKind::Delete,
        _ => ChunkKind::Replace,
    };
    if unimportant {
        out.stats.unimportant += 1;
    } else {
        let mut paired = 0;
        if kind == ChunkKind::Replace && opts.inline != InlineMode::None {
            let found = pair_lines(left_lines, right_lines, left.clone(), right.clone(), opts);
            paired = found.len() as u32;
            out.pairs.extend(found);
        }
        out.stats.modified += paired;
        out.stats.deleted += left.len() as u32 - paired;
        out.stats.inserted += right.len() as u32 - paired;
        out.stats.changes += 1;
    }
    out.chunks.push(Chunk {
        kind,
        left,
        right,
        unimportant,
    });
}

/// Finds which left lines correspond to which right lines inside a replace chunk, keeping order.
fn pair_lines(
    left: &[Line<'_>],
    right: &[Line<'_>],
    lr: Range<u32>,
    rr: Range<u32>,
    opts: &DiffOptions,
) -> Vec<LinePair> {
    let (n, m) = (lr.len(), rr.len());
    let compare = |i: usize, j: usize| {
        inline_diff(
            left[lr.start as usize + i].text,
            right[rr.start as usize + j].text,
            opts,
        )
    };
    let make = |i: usize, j: usize, d: InlineDiff| LinePair {
        left_line: lr.start + i as u32,
        right_line: rr.start + j as u32,
        left_ranges: d.left,
        right_ranges: d.right,
    };

    // Equal-sized blocks are line-for-line edits: pair every line, as a reader would expect.
    if n == m {
        return (0..n)
            .map(|i| {
                let mut d = compare(i, i);
                // Lines that were rewritten entirely read better without word-level noise.
                if d.similarity < MIN_PAIR_SIMILARITY {
                    d.left.clear();
                    d.right.clear();
                }
                make(i, i, d)
            })
            .collect();
    }
    if n * m > MAX_ALIGN_CELLS {
        return (0..n.min(m))
            .filter_map(|i| {
                let d = compare(i, i);
                (d.similarity >= MIN_PAIR_SIMILARITY).then(|| make(i, i, d))
            })
            .collect();
    }

    // Order-preserving alignment that maximises total similarity (Needleman-Wunsch without gap cost).
    let mut sims = vec![None; n * m];
    let mut score = vec![0f32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in 1..=n {
        for j in 1..=m {
            let d = compare(i - 1, j - 1);
            let mut best = score[at(i - 1, j)].max(score[at(i, j - 1)]);
            if d.similarity >= MIN_PAIR_SIMILARITY {
                best = best.max(score[at(i - 1, j - 1)] + d.similarity);
            }
            score[at(i, j)] = best;
            sims[(i - 1) * m + (j - 1)] = Some(d);
        }
    }

    let mut pairs = Vec::new();
    let (mut i, mut j) = (n, m);
    while i > 0 && j > 0 {
        let s = score[at(i, j)];
        if s == score[at(i - 1, j)] {
            i -= 1;
        } else if s == score[at(i, j - 1)] {
            j -= 1;
        } else {
            let d = sims[(i - 1) * m + (j - 1)].take().unwrap();
            pairs.push(make(i - 1, j - 1, d));
            i -= 1;
            j -= 1;
        }
    }
    pairs.reverse();
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(d: &TextDiff) -> Vec<(ChunkKind, Range<u32>, Range<u32>)> {
        d.chunks
            .iter()
            .map(|c| (c.kind, c.left.clone(), c.right.clone()))
            .collect()
    }

    #[test]
    fn identical_texts() {
        let d = diff_text("a\nb\n", "a\nb\n", &DiffOptions::default());
        assert!(d.is_identical());
        assert_eq!(kinds(&d), [(ChunkKind::Equal, 0..3, 0..3)]);
    }

    #[test]
    fn chunks_cover_both_sides() {
        let d = diff_text("a\nb\nc\nd", "a\nB\nc\nx\nd", &DiffOptions::default());
        assert_eq!(
            kinds(&d),
            [
                (ChunkKind::Equal, 0..1, 0..1),
                (ChunkKind::Replace, 1..2, 1..2),
                (ChunkKind::Equal, 2..3, 2..3),
                (ChunkKind::Insert, 3..3, 3..4),
                (ChunkKind::Equal, 3..4, 4..5),
            ]
        );
        assert_eq!(
            d.stats,
            DiffStats {
                left_lines: 4,
                right_lines: 5,
                inserted: 1,
                deleted: 0,
                modified: 1,
                changes: 2,
                unimportant: 0,
            }
        );
    }

    #[test]
    fn options_hide_differences() {
        let (a, b) = ("Hello  World\r\nfoo", "hello world\nfoo");
        assert!(!diff_text(a, b, &DiffOptions::default()).is_identical());
        let opts = DiffOptions {
            whitespace: WhitespaceMode::Collapse,
            ignore_case: true,
            ..Default::default()
        };
        assert!(diff_text(a, b, &opts).is_identical());
        let strict_eol = DiffOptions {
            ignore_line_endings: false,
            ..opts
        };
        assert!(!diff_text(a, b, &strict_eol).is_identical());
    }

    #[test]
    fn pairs_similar_lines_and_leaves_others_unpaired() {
        let left = "fn main() {\n    let x = 1;\n}";
        let right = "fn main() {\n    // completely new comment here\n    let x = 2;\n}";
        let d = diff_text(left, right, &DiffOptions::default());
        assert_eq!(d.pairs.len(), 1);
        let p = &d.pairs[0];
        assert_eq!((p.left_line, p.right_line), (1, 2));
        assert_eq!(p.left_ranges, [12..13]);
        assert_eq!(d.stats.inserted, 1);
        assert_eq!(d.stats.modified, 1);
    }

    #[test]
    fn converts_offsets_to_utf16() {
        let (a, b) = ("가 x", "가 y");
        let mut d = diff_text(a, b, &DiffOptions::default());
        assert_eq!(d.pairs[0].left_ranges, [4..5]);
        d.convert_offsets_to_utf16(a, b);
        assert_eq!(d.pairs[0].left_ranges, [2..3]);
    }

    #[test]
    fn large_input_is_fast_enough() {
        let left: String = (0..200_000).map(|i| format!("line {i}\n")).collect();
        let right = left.replace("line 1000\n", "line one thousand\n");
        let d = diff_text(&left, &right, &DiffOptions::default());
        assert_eq!(d.stats.modified, 1);
    }

    #[test]
    fn ignore_rules_hide_unimportant_changes() {
        let left = "let a = 1; // first\n// old note\nlet b = 2;\nlet c = 3;";
        let right = "let a = 1; // changed\nlet b = 2;\n\n# shell\nlet c = 4;";
        let opts = DiffOptions {
            ignore: vec!["//.*".into(), "#.*".into()],
            whitespace: WhitespaceMode::Trim,
            ..Default::default()
        };
        let d = diff_text(left, right, &opts);
        let kinds: Vec<_> = d.chunks.iter().map(|c| (c.kind, c.unimportant)).collect();
        // The trailing comment change is ignored entirely and the comment-only line deletion is
        // unimportant. The blank line counts by default, so it keeps "# shell" inside the real
        // change c = 3 -> 4.
        assert_eq!(
            kinds,
            [
                (ChunkKind::Equal, false),
                (ChunkKind::Delete, true),
                (ChunkKind::Equal, false),
                (ChunkKind::Replace, false),
            ]
        );
        assert_eq!((d.stats.changes, d.stats.unimportant), (1, 1));
        assert!(d.invalid_patterns.is_empty());

        let d = diff_text(
            left,
            right,
            &DiffOptions {
                ignore_blank_lines: true,
                ..opts
            },
        );
        // Ignoring blank lines too splits them and "# shell" off the front of the change.
        assert_eq!((d.stats.changes, d.stats.unimportant), (1, 2));
        assert_eq!(d.chunks[3].right, 2..4);
        assert!(d.chunks[3].unimportant);
    }
}
