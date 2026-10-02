//! Three-way merge: combines the changes two sides made to a common base.

use std::ops::Range;

use crate::lines::{split_lines, Keyer};
use crate::{diff_text, ChunkKind, DiffOptions, InlineMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum RegionKind {
    /// Neither side changed these base lines.
    Unchanged,
    /// Only the left side changed them; the merge takes the left lines.
    Left,
    /// Only the right side changed them; the merge takes the right lines.
    Right,
    /// Both sides made the same change.
    Both,
    /// Both sides changed them differently; someone has to decide.
    Conflict,
}

/// A run of lines with one outcome. Ranges are 0-based line indices into each text; regions
/// cover all three texts completely and in order.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct MergeRegion {
    pub kind: RegionKind,
    pub base: Range<u32>,
    pub left: Range<u32>,
    pub right: Range<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct MergeStats {
    pub left_changes: u32,
    pub right_changes: u32,
    pub both_changes: u32,
    pub conflicts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Merge3 {
    pub regions: Vec<MergeRegion>,
    pub stats: MergeStats,
}

/// One change a side made: `base` lines became `side` lines.
#[derive(Debug, Clone)]
struct Hunk {
    base: Range<u32>,
    side: Range<u32>,
}

fn hunks(base: &str, side: &str, opts: &DiffOptions) -> Vec<Hunk> {
    let opts = DiffOptions {
        inline: InlineMode::None,
        ..opts.clone()
    };
    diff_text(base, side, &opts)
        .chunks
        .into_iter()
        .filter(|c| c.kind != ChunkKind::Equal)
        .map(|c| Hunk {
            base: c.left,
            side: c.right,
        })
        .collect()
}

/// Whether a change touching base lines `a` must be merged together with one touching `b`.
/// Two insertions at the same place count, since their order can't be decided.
fn overlaps(a: &Range<u32>, b: &Range<u32>) -> bool {
    (a.start < b.end && b.start < a.end) || a.start == b.start
}

/// The side's lines that correspond to base lines `range`, given the side's hunks inside it
/// (`group`) and the line count difference its earlier hunks introduced (`delta`).
fn side_range(range: &Range<u32>, group: &[Hunk], delta: i64) -> Range<u32> {
    match (group.first(), group.last()) {
        (Some(first), Some(last)) => {
            (first.side.start - (first.base.start - range.start))
                ..(last.side.end + (range.end - last.base.end))
        }
        _ => ((range.start as i64 + delta) as u32)..((range.end as i64 + delta) as u32),
    }
}

/// Merges the changes `left` and `right` each made to `base`, line by line. Lines are compared
/// with `opts` (whitespace, case and line-ending rules), so changes that only differ in what the
/// options ignore are treated as the same change.
pub fn merge3(base: &str, left: &str, right: &str, opts: &DiffOptions) -> Merge3 {
    let base_len = split_lines(base).len() as u32;
    let (left_lines, right_lines) = (split_lines(left), split_lines(right));
    let (lh, rh) = (hunks(base, left, opts), hunks(base, right, opts));
    let (keyer, _) = Keyer::new(opts);

    let mut out = Merge3::default();
    let (mut i, mut j) = (0, 0);
    // Line count differences introduced by each side's hunks so far.
    let (mut ld, mut rd) = (0i64, 0i64);
    let mut pos = 0u32;
    let unchanged = |out: &mut Merge3, from: u32, to: u32, ld: i64, rd: i64| {
        if to > from {
            out.regions.push(MergeRegion {
                kind: RegionKind::Unchanged,
                base: from..to,
                left: side_range(&(from..to), &[], ld),
                right: side_range(&(from..to), &[], rd),
            });
        }
    };

    while i < lh.len() || j < rh.len() {
        // Start a group with whichever hunk comes first in the base, then pull in every hunk
        // from either side that overlaps the group until it stops growing.
        let take_left = j >= rh.len() || (i < lh.len() && lh[i].base.start <= rh[j].base.start);
        let mut range = if take_left {
            lh[i].base.clone()
        } else {
            rh[j].base.clone()
        };
        let (li, ri) = (i, j);
        loop {
            let mut grew = false;
            while i < lh.len() && (i == li && take_left || overlaps(&lh[i].base, &range)) {
                range = range.start.min(lh[i].base.start)..range.end.max(lh[i].base.end);
                i += 1;
                grew = true;
            }
            while j < rh.len() && (j == ri && !take_left || overlaps(&rh[j].base, &range)) {
                range = range.start.min(rh[j].base.start)..range.end.max(rh[j].base.end);
                j += 1;
                grew = true;
            }
            if !grew {
                break;
            }
        }

        unchanged(&mut out, pos, range.start, ld, rd);
        let (lg, rg) = (&lh[li..i], &rh[ri..j]);
        let left = side_range(&range, lg, ld);
        let right = side_range(&range, rg, rd);
        let kind = match (lg.is_empty(), rg.is_empty()) {
            (false, true) => RegionKind::Left,
            (true, false) => RegionKind::Right,
            _ => {
                let key = |lines: &[crate::Line<'_>], r: &Range<u32>| -> Vec<String> {
                    lines[r.start as usize..r.end as usize]
                        .iter()
                        .map(|l| keyer.key(l))
                        .collect()
                };
                if key(&left_lines, &left) == key(&right_lines, &right) {
                    RegionKind::Both
                } else {
                    RegionKind::Conflict
                }
            }
        };
        match kind {
            RegionKind::Left => out.stats.left_changes += 1,
            RegionKind::Right => out.stats.right_changes += 1,
            RegionKind::Both => out.stats.both_changes += 1,
            RegionKind::Conflict => out.stats.conflicts += 1,
            RegionKind::Unchanged => {}
        }
        ld = left.end as i64 - range.end as i64;
        rd = right.end as i64 - range.end as i64;
        out.regions.push(MergeRegion {
            kind,
            base: range.clone(),
            left,
            right,
        });
        pos = range.end;
    }
    unchanged(&mut out, pos, base_len, ld, rd);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Applies the regions the way the UI does, writing conflicts as `<L|R>`.
    fn merged(base: &str, left: &str, right: &str) -> (String, MergeStats) {
        let m = merge3(base, left, right, &DiffOptions::default());
        let (b, l, r) = (split_lines(base), split_lines(left), split_lines(right));
        let text = |lines: &[crate::Line<'_>], range: &Range<u32>| -> Vec<String> {
            lines[range.start as usize..range.end as usize]
                .iter()
                .map(|x| x.text.to_owned())
                .collect()
        };
        let mut out: Vec<String> = Vec::new();
        for reg in &m.regions {
            match reg.kind {
                RegionKind::Unchanged => out.extend(text(&b, &reg.base)),
                RegionKind::Left | RegionKind::Both => out.extend(text(&l, &reg.left)),
                RegionKind::Right => out.extend(text(&r, &reg.right)),
                RegionKind::Conflict => out.push(format!(
                    "<{}|{}>",
                    text(&l, &reg.left).join(","),
                    text(&r, &reg.right).join(",")
                )),
            }
        }
        // Regions must tile all three inputs.
        for (lines, pick) in [(&b, 0), (&l, 1), (&r, 2)] {
            let mut at = 0;
            for reg in &m.regions {
                let range = [&reg.base, &reg.left, &reg.right][pick];
                assert_eq!(
                    range.start, at,
                    "regions must be contiguous: {:?}",
                    m.regions
                );
                at = range.end;
            }
            assert_eq!(at as usize, lines.len());
        }
        (out.join("\n"), m.stats)
    }

    #[test]
    fn takes_changes_from_both_sides() {
        let (text, stats) = merged("a\nb\nc\nd\ne", "A\nb\nc\nd\ne", "a\nb\nc\nd\nE");
        assert_eq!(text, "A\nb\nc\nd\nE");
        assert_eq!(
            (stats.left_changes, stats.right_changes, stats.conflicts),
            (1, 1, 0)
        );
    }

    #[test]
    fn inserts_and_deletes() {
        let (text, _) = merged("a\nb\nc\nd", "a\nx\nb\nc\nd", "a\nb\nd");
        assert_eq!(text, "a\nx\nb\nd");
    }

    #[test]
    fn same_change_is_not_a_conflict() {
        let (text, stats) = merged("a\nb\nc", "a\nB\nc", "a\nB\nc");
        assert_eq!(text, "a\nB\nc");
        assert_eq!((stats.both_changes, stats.conflicts), (1, 0));
    }

    #[test]
    fn different_changes_conflict() {
        let (text, stats) = merged("a\nb\nc", "a\nL\nc", "a\nR\nc");
        assert_eq!(text, "a\n<L|R>\nc");
        assert_eq!(stats.conflicts, 1);
        // Two insertions at the same place.
        let (text, _) = merged("a\nc", "a\nx\nc", "a\ny\nc");
        assert_eq!(text, "a\n<x|y>\nc");
        // A deletion against an edit of the same line.
        let (text, _) = merged("a\nb\nc", "a\nc", "a\nB\nc");
        assert_eq!(text, "a\n<|B>\nc");
    }

    #[test]
    fn overlapping_changes_grow_into_one_conflict() {
        // Left changes b..c, right changes c..d: one conflict covering b..d.
        let (text, stats) = merged("a\nb\nc\nd\ne", "a\nB\nC\nd\ne", "a\nb\nC2\nD\ne");
        assert_eq!(text, "a\n<B,C,d|b,C2,D>\ne");
        assert_eq!(stats.conflicts, 1);
    }

    #[test]
    fn edge_cases() {
        assert_eq!(merged("", "", "").0, "");
        assert_eq!(merged("", "x", "").0, "x");
        assert_eq!(merged("a", "a", "a").0, "a");
        // Appending at the end on both sides differently.
        assert_eq!(merged("a\n", "a\nl\n", "a\nr\n").0, "a\n<l|r>\n");
        // Changes far apart after length-changing edits keep their alignment.
        let (text, _) = merged(
            "1\n2\n3\n4\n5\n6",
            "1\nx\ny\nz\n2\n3\n4\n5\n6",
            "1\n2\n3\n4\n5\nSIX",
        );
        assert_eq!(text, "1\nx\ny\nz\n2\n3\n4\n5\nSIX");
    }

    #[test]
    fn random_inputs_tile_and_pass_one_sided_changes_through() {
        // Small deterministic generator, so the test needs no extra crates.
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        let text = |next: &mut dyn FnMut(u64) -> u64| -> String {
            let len = next(8);
            (0..len)
                .map(|_| ["a", "b", "c", "d"][next(4) as usize])
                .collect::<Vec<_>>()
                .join("\n")
        };
        for _ in 0..2000 {
            let (base, side) = (text(&mut next), text(&mut next));
            // `merged` checks that the regions tile all three inputs.
            assert_eq!(merged(&base, &side, &base).0, side, "left-only change");
            assert_eq!(merged(&base, &base, &side).0, side, "right-only change");
            assert_eq!(merged(&base, &side, &side).0, side, "same change");
            let other = text(&mut next);
            merged(&base, &side, &other);
        }
    }
}
