//! Byte-level comparison for the hex view.

use std::ops::Range;

use imara_diff::{Algorithm, Diff, InternedInput, Token};

use crate::ChunkKind;

/// How bytes on the two sides are matched up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum BinaryMode {
    /// Byte N on the left is compared with byte N on the right. Best for patched files of the
    /// same layout (firmware, save files, images) and works for any size.
    Aligned,
    /// Finds inserted and deleted bytes so that later data lines up again. Falls back to
    /// `Aligned` for inputs larger than [`SMART_LIMIT`].
    #[default]
    Smart,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase", default))]
pub struct BinaryOptions {
    pub mode: BinaryMode,
}

/// Larger inputs (per side) are compared with [`BinaryMode::Aligned`] to keep time and memory bounded.
pub const SMART_LIMIT: usize = 64 * 1024 * 1024;

/// A run of bytes with the same status. Ranges are byte offsets; chunks cover both inputs in order.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ByteChunk {
    pub kind: ChunkKind,
    pub left: Range<u64>,
    pub right: Range<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct BinaryStats {
    pub left_len: u64,
    pub right_len: u64,
    /// Number of non-equal chunks.
    pub changes: u32,
    /// Bytes in replace chunks (counted on the longer side).
    pub changed: u64,
    /// Bytes only on the right.
    pub inserted: u64,
    /// Bytes only on the left.
    pub deleted: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct BinaryDiff {
    pub chunks: Vec<ByteChunk>,
    pub stats: BinaryStats,
    /// The mode actually used; differs from the requested one after a size fallback.
    pub mode: BinaryMode,
}

impl BinaryDiff {
    pub fn is_identical(&self) -> bool {
        self.stats.changes == 0
    }
}

/// Compares two byte sequences.
pub fn diff_bytes(left: &[u8], right: &[u8], opts: &BinaryOptions) -> BinaryDiff {
    let smart = opts.mode == BinaryMode::Smart && left.len().max(right.len()) <= SMART_LIMIT;
    let mut out = BinaryDiff {
        mode: if smart {
            BinaryMode::Smart
        } else {
            BinaryMode::Aligned
        },
        ..Default::default()
    };
    if smart {
        smart_chunks(left, right, &mut out.chunks);
    } else {
        aligned_chunks(left, right, &mut out.chunks);
    }
    limit_chunks(&mut out.chunks, MAX_CHUNKS);

    out.stats.left_len = left.len() as u64;
    out.stats.right_len = right.len() as u64;
    for c in &out.chunks {
        let (l, r) = (c.left.end - c.left.start, c.right.end - c.right.start);
        match c.kind {
            ChunkKind::Equal => continue,
            ChunkKind::Insert => out.stats.inserted += r,
            ChunkKind::Delete => out.stats.deleted += l,
            ChunkKind::Replace => out.stats.changed += l.max(r),
        }
        out.stats.changes += 1;
    }
    out
}

/// Unrelated data produces a change every few bytes wherever bytes coincide by chance; past
/// this many chunks the result is unreadable and too large to send to the UI.
pub const MAX_CHUNKS: usize = 20_000;

/// Absorbs short equal runs between changes into the surrounding change, raising the length
/// threshold until at most `max` chunks remain. Equal runs at the very start or end are kept.
fn limit_chunks(chunks: &mut Vec<ByteChunk>, max: usize) {
    let mut threshold = 8u64;
    while chunks.len() > max {
        let mut merged: Vec<ByteChunk> = Vec::with_capacity(chunks.len() / 2);
        let mut i = 0;
        while i < chunks.len() {
            let c = chunks[i].clone();
            let absorb = |m: &mut Vec<ByteChunk>| match m.last_mut() {
                Some(prev) if prev.kind != ChunkKind::Equal => {
                    prev.left.end = c.left.end;
                    prev.right.end = c.right.end;
                    true
                }
                _ => false,
            };
            let short_gap = c.kind == ChunkKind::Equal
                && c.left.end - c.left.start < threshold
                && i + 1 < chunks.len();
            let joined = if c.kind != ChunkKind::Equal || short_gap {
                absorb(&mut merged)
            } else {
                false
            };
            if !joined {
                merged.push(c);
            }
            i += 1;
        }
        for c in &mut merged {
            if c.kind != ChunkKind::Equal {
                c.kind = match (c.left.is_empty(), c.right.is_empty()) {
                    (true, _) => ChunkKind::Insert,
                    (_, true) => ChunkKind::Delete,
                    _ => ChunkKind::Replace,
                };
            }
        }
        *chunks = merged;
        threshold *= 8;
    }
}

fn push(out: &mut Vec<ByteChunk>, kind: ChunkKind, left: Range<usize>, right: Range<usize>) {
    if left.is_empty() && right.is_empty() {
        return;
    }
    out.push(ByteChunk {
        kind,
        left: left.start as u64..left.end as u64,
        right: right.start as u64..right.end as u64,
    });
}

fn aligned_chunks(left: &[u8], right: &[u8], out: &mut Vec<ByteChunk>) {
    let n = left.len().min(right.len());
    let mut i = 0;
    while i < n {
        let start = i;
        let same = left[i] == right[i];
        while i < n && (left[i] == right[i]) == same {
            i += 1;
        }
        let kind = if same {
            ChunkKind::Equal
        } else {
            ChunkKind::Replace
        };
        push(out, kind, start..i, start..i);
    }
    push(out, ChunkKind::Delete, n..left.len(), n..n);
    push(out, ChunkKind::Insert, n..n, n..right.len());
}

/// Smart mode in two passes. First the inputs are cut into content-defined segments (cut
/// points depend only on nearby bytes, so they re-synchronise after an insertion) and the
/// segments are diffed. Then each small changed region is refined byte by byte. Diffing raw
/// bytes directly is far too slow: with only 256 symbols, random data matches everywhere.
fn smart_chunks(left: &[u8], right: &[u8], out: &mut Vec<ByteChunk>) {
    // Common prefix and suffix first, at byte level: a single local edit then lines up exactly
    // even inside long runs of identical bytes (zero padding), where segments are ambiguous.
    let prefix = left.iter().zip(right).take_while(|(a, b)| a == b).count();
    let max_suffix = left.len().min(right.len()) - prefix;
    let suffix = left
        .iter()
        .rev()
        .zip(right.iter().rev())
        .take(max_suffix)
        .take_while(|(a, b)| a == b)
        .count();
    let (lm, rm) = (prefix..left.len() - suffix, prefix..right.len() - suffix);
    push(out, ChunkKind::Equal, 0..prefix, 0..prefix);

    let (ls, rs) = (segments(&left[lm.clone()]), segments(&right[rm.clone()]));
    let mut input: InternedInput<&[u8]> = InternedInput::default();
    input.update_before(
        ls.iter()
            .map(|r| &left[lm.start + r.start..lm.start + r.end]),
    );
    input.update_after(
        rs.iter()
            .map(|r| &right[rm.start + r.start..rm.start + r.end]),
    );
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_no_heuristic(&input);

    // Segment index -> byte offset (an index equal to the length maps to the end of the region).
    let lo = |i: u32| lm.start + ls.get(i as usize).map_or(lm.len(), |r| r.start);
    let ro = |i: u32| rm.start + rs.get(i as usize).map_or(rm.len(), |r| r.start);
    let (mut l, mut r) = (lm.start, rm.start);
    for hunk in diff.hunks() {
        let hl = lo(hunk.before.start)..lo(hunk.before.end);
        let hr = ro(hunk.after.start)..ro(hunk.after.end);
        push(out, ChunkKind::Equal, l..hl.start, r..hr.start);
        refine(left, right, hl.clone(), hr.clone(), out);
        (l, r) = (hl.end, hr.end);
    }
    push(out, ChunkKind::Equal, l..left.len(), r..right.len());
    merge_equal(out);
}

/// Joins adjacent equal chunks produced by the prefix/suffix split.
fn merge_equal(out: &mut Vec<ByteChunk>) {
    out.dedup_by(|next, prev| {
        if prev.kind == ChunkKind::Equal && next.kind == ChunkKind::Equal {
            prev.left.end = next.left.end;
            prev.right.end = next.right.end;
            true
        } else {
            false
        }
    });
}

/// Regions larger than this (per side) are reported as one change instead of being refined.
const REFINE_LIMIT: usize = 4096;

fn refine(left: &[u8], right: &[u8], hl: Range<usize>, hr: Range<usize>, out: &mut Vec<ByteChunk>) {
    let kind_of = |l: &Range<usize>, r: &Range<usize>| match (l.is_empty(), r.is_empty()) {
        (true, _) => ChunkKind::Insert,
        (_, true) => ChunkKind::Delete,
        _ => ChunkKind::Replace,
    };
    if hl.is_empty() || hr.is_empty() || hl.len() > REFINE_LIMIT || hr.len() > REFINE_LIMIT {
        let kind = kind_of(&hl, &hr);
        push(out, kind, hl, hr);
        return;
    }
    let tokens = |bytes: &[u8]| bytes.iter().map(|&b| Token(b as u32)).collect::<Vec<_>>();
    let mut diff = Diff::default();
    diff.compute_with(
        Algorithm::Myers,
        &tokens(&left[hl.clone()]),
        &tokens(&right[hr.clone()]),
        256,
    );
    let (mut l, mut r) = (hl.start, hr.start);
    for hunk in diff.hunks() {
        let bl = hl.start + hunk.before.start as usize..hl.start + hunk.before.end as usize;
        let br = hr.start + hunk.after.start as usize..hr.start + hunk.after.end as usize;
        push(out, ChunkKind::Equal, l..bl.start, r..br.start);
        let kind = kind_of(&bl, &br);
        (l, r) = (bl.end, br.end);
        push(out, kind, bl, br);
    }
    push(out, ChunkKind::Equal, l..hl.end, r..hr.end);
}

const MIN_SEGMENT: usize = 8;
const MAX_SEGMENT: usize = 256;
/// Cut when the low 5 bits of the rolling hash are zero: segments average about 32 bytes.
const CUT_MASK: u64 = 0x1f;

/// Pseudo-random value per byte for the rolling ("gear") hash.
const GEAR: [u64; 256] = {
    let mut table = [0u64; 256];
    let mut x = 0x9e37_79b9_7f4a_7c15u64;
    let mut i = 0;
    while i < 256 {
        x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        table[i] = z ^ (z >> 31);
        i += 1;
    }
    table
};

fn segments(bytes: &[u8]) -> Vec<Range<usize>> {
    let mut out = Vec::with_capacity(bytes.len() / 32 + 1);
    let (mut start, mut hash) = (0usize, 0u64);
    for (i, &b) in bytes.iter().enumerate() {
        hash = (hash << 1).wrapping_add(GEAR[b as usize]);
        let len = i + 1 - start;
        if (len >= MIN_SEGMENT && hash & CUT_MASK == 0) || len >= MAX_SEGMENT {
            out.push(start..i + 1);
            start = i + 1;
        }
    }
    if start < bytes.len() {
        out.push(start..bytes.len());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(d: &BinaryDiff) -> Vec<(ChunkKind, Range<u64>, Range<u64>)> {
        d.chunks
            .iter()
            .map(|c| (c.kind, c.left.clone(), c.right.clone()))
            .collect()
    }

    const ALIGNED: BinaryOptions = BinaryOptions {
        mode: BinaryMode::Aligned,
    };

    #[test]
    fn identical_and_empty() {
        let d = diff_bytes(b"abc", b"abc", &BinaryOptions::default());
        assert!(d.is_identical());
        assert_eq!(summary(&d), [(ChunkKind::Equal, 0..3, 0..3)]);
        assert!(diff_bytes(b"", b"", &BinaryOptions::default())
            .chunks
            .is_empty());
    }

    #[test]
    fn aligned_compares_by_offset() {
        let d = diff_bytes(&[1, 2, 3, 4, 5], &[1, 9, 9, 4], &ALIGNED);
        assert_eq!(
            summary(&d),
            [
                (ChunkKind::Equal, 0..1, 0..1),
                (ChunkKind::Replace, 1..3, 1..3),
                (ChunkKind::Equal, 3..4, 3..4),
                (ChunkKind::Delete, 4..5, 4..4),
            ]
        );
        assert_eq!(
            d.stats,
            BinaryStats {
                left_len: 5,
                right_len: 4,
                changes: 2,
                changed: 2,
                inserted: 0,
                deleted: 1
            }
        );
    }

    #[test]
    fn smart_finds_insertions() {
        let left = b"HEADER-payload-FOOTER";
        let right = b"HEADER-new-payload-FOOTER";
        let d = diff_bytes(left, right, &BinaryOptions::default());
        assert_eq!(d.mode, BinaryMode::Smart);
        assert_eq!(
            summary(&d),
            [
                (ChunkKind::Equal, 0..7, 0..7),
                (ChunkKind::Insert, 7..7, 7..11),
                (ChunkKind::Equal, 7..21, 11..25),
            ]
        );
        // The same input compared by offset differs almost everywhere after the insertion.
        assert!(diff_bytes(left, right, &ALIGNED).stats.changed > 4);
    }

    #[test]
    fn large_inputs_fall_back_to_aligned() {
        let left = vec![0u8; SMART_LIMIT + 1];
        let mut right = left.clone();
        right[100] = 1;
        let d = diff_bytes(&left, &right, &BinaryOptions::default());
        assert_eq!(d.mode, BinaryMode::Aligned);
        assert_eq!(d.stats.changes, 1);
    }

    #[test]
    fn unrelated_data_is_capped_to_readable_changes() {
        // Same layout (zero headers every 64 bytes), unrelated payloads: chance matches everywhere.
        let make = |seed: u32| {
            let mut x = seed;
            (0..3_000_000)
                .map(|i| {
                    x = x.wrapping_mul(1103515245).wrapping_add(12345);
                    if i % 64 < 8 {
                        0
                    } else {
                        (x >> 16) as u8
                    }
                })
                .collect::<Vec<u8>>()
        };
        let (left, right) = (make(7), make(99));
        for opts in [BinaryOptions::default(), ALIGNED] {
            let d = diff_bytes(&left, &right, &opts);
            assert!(d.chunks.len() <= MAX_CHUNKS, "{} chunks", d.chunks.len());
            // Chunks still cover both inputs in order.
            let (mut l, mut r) = (0, 0);
            for c in &d.chunks {
                assert_eq!((c.left.start, c.right.start), (l, r));
                (l, r) = (c.left.end, c.right.end);
            }
            assert_eq!((l, r), (3_000_000, 3_000_000));
        }
    }

    #[test]
    fn limit_keeps_small_results_untouched() {
        let d = diff_bytes(&[1, 2, 3, 4, 5], &[1, 9, 3, 9, 5], &ALIGNED);
        assert_eq!(d.chunks.len(), 5);
    }

    #[test]
    fn smart_handles_repetitive_data() {
        let left = vec![0u8; 4_000_000];
        let mut right = left.clone();
        right.splice(2_000_000..2_000_000, *b"x");
        let d = diff_bytes(&left, &right, &BinaryOptions::default());
        assert_eq!(
            summary(&d),
            [
                (ChunkKind::Equal, 0..2_000_000, 0..2_000_000),
                (
                    ChunkKind::Insert,
                    2_000_000..2_000_000,
                    2_000_000..2_000_001
                ),
                (ChunkKind::Equal, 2_000_000..4_000_000, 2_000_001..4_000_001),
            ]
        );
    }

    #[test]
    fn smart_handles_megabytes_of_random_data() {
        // xorshift: deterministic pseudo-random bytes, the worst case for byte matching.
        let mut x = 0x2545_f491_4f6c_dd1du64;
        let left: Vec<u8> = (0..2_000_000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect();
        let mut right = left.clone();
        right.splice(1_000_000..1_000_000, *b"inserted");
        right[1_500_000] ^= 0xff;
        let d = diff_bytes(&left, &right, &BinaryOptions::default());
        assert_eq!(d.stats.inserted, 8);
        assert_eq!(d.stats.changed, 1);
    }
}
