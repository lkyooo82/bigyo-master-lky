//! Intra-line diff: which parts of two similar lines differ.

use std::ops::Range;

use imara_diff::{Algorithm, Diff, InternedInput};

use crate::options::{DiffOptions, InlineMode, WhitespaceMode};

struct Token {
    span: Range<usize>,
    key: String,
}

/// Result of comparing two lines token by token. Ranges are byte offsets into each line.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InlineDiff {
    pub left: Vec<Range<u32>>,
    pub right: Vec<Range<u32>>,
    /// 0.0 (nothing in common) to 1.0 (equal under the options).
    pub similarity: f32,
}

/// Compares two lines and returns the changed byte ranges on each side.
pub fn inline_diff(left: &str, right: &str, opts: &DiffOptions) -> InlineDiff {
    let mode = if opts.inline == InlineMode::None {
        InlineMode::Word
    } else {
        opts.inline
    };
    let (l, r, sim) = token_diff(left, right, mode, opts);
    // Similarity is always measured per character so that a one-word line that changed a
    // letter still counts as similar.
    let similarity = if mode == InlineMode::Char {
        sim
    } else {
        token_diff(left, right, InlineMode::Char, opts).2
    };
    InlineDiff {
        left: l,
        right: r,
        similarity,
    }
}

fn token_diff(
    left: &str,
    right: &str,
    mode: InlineMode,
    opts: &DiffOptions,
) -> (Vec<Range<u32>>, Vec<Range<u32>>, f32) {
    let lt = tokenize(left, mode, opts);
    let rt = tokenize(right, mode, opts);

    let mut input: InternedInput<&str> = InternedInput::default();
    input.update_before(lt.iter().map(|t| t.key.as_str()));
    input.update_after(rt.iter().map(|t| t.key.as_str()));
    let mut diff = Diff::compute(Algorithm::Myers, &input);
    diff.postprocess_no_heuristic(&input);

    let (mut l, mut r) = (Vec::new(), Vec::new());
    let mut changed = 0usize;
    for hunk in diff.hunks() {
        changed += span_len(&lt, hunk.before.clone()) + span_len(&rt, hunk.after.clone());
        push_span(&mut l, &lt, hunk.before);
        push_span(&mut r, &rt, hunk.after);
    }
    let total = span_len(&lt, 0..lt.len() as u32) + span_len(&rt, 0..rt.len() as u32);
    let sim = if total == 0 {
        1.0
    } else {
        1.0 - changed as f32 / total as f32
    };
    (l, r, sim)
}

/// Number of characters in the given tokens.
fn span_len(tokens: &[Token], range: Range<u32>) -> usize {
    tokens[range.start as usize..range.end as usize]
        .iter()
        .map(|t| t.key.chars().count())
        .sum()
}

fn push_span(out: &mut Vec<Range<u32>>, tokens: &[Token], range: Range<u32>) {
    if range.is_empty() {
        return;
    }
    let start = tokens[range.start as usize].span.start as u32;
    let end = tokens[range.end as usize - 1].span.end as u32;
    match out.last_mut() {
        Some(last) if last.end == start => last.end = end,
        _ => out.push(start..end),
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Class {
    Space,
    Word,
    Other,
}

fn class(c: char) -> Class {
    if c.is_whitespace() {
        Class::Space
    } else if c.is_alphanumeric() || c == '_' {
        Class::Word
    } else {
        Class::Other
    }
}

/// Splits a line into tokens. Whitespace that the options ignore produces no token, so it is
/// never highlighted.
fn tokenize(line: &str, mode: InlineMode, opts: &DiffOptions) -> Vec<Token> {
    let mut spans: Vec<(Range<usize>, Class)> = Vec::new();
    for (i, c) in line.char_indices() {
        let cls = class(c);
        let joins = match spans.last() {
            Some((_, prev)) => {
                *prev == cls
                    && (cls == Class::Space || (mode == InlineMode::Word && cls == Class::Word))
            }
            None => false,
        };
        if joins {
            spans.last_mut().unwrap().0.end = i + c.len_utf8();
        } else {
            spans.push((i..i + c.len_utf8(), cls));
        }
    }

    let last = spans.len().saturating_sub(1);
    let mut tokens = Vec::with_capacity(spans.len());
    for (idx, (span, cls)) in spans.into_iter().enumerate() {
        let text = &line[span.clone()];
        let key = if cls == Class::Space {
            let edge = idx == 0 || idx == last;
            match opts.whitespace {
                WhitespaceMode::Exact => text.to_owned(),
                WhitespaceMode::Trim if edge => continue,
                WhitespaceMode::Trim => text.to_owned(),
                WhitespaceMode::Collapse if edge => continue,
                WhitespaceMode::Collapse => " ".to_owned(),
                WhitespaceMode::IgnoreAll => continue,
            }
        } else if opts.ignore_case {
            text.to_lowercase()
        } else {
            text.to_owned()
        };
        tokens.push(Token { span, key });
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranges<'a>(line: &'a str, rs: &[Range<u32>]) -> Vec<&'a str> {
        rs.iter()
            .map(|r| &line[r.start as usize..r.end as usize])
            .collect()
    }

    #[test]
    fn highlights_changed_words() {
        let (a, b) = (
            "let total = price * count;",
            "let total = cost * count + tax;",
        );
        let d = inline_diff(a, b, &DiffOptions::default());
        assert_eq!(ranges(a, &d.left), ["price"]);
        assert_eq!(ranges(b, &d.right), ["cost", " + tax"]);
        assert!(d.similarity > 0.5);
    }

    #[test]
    fn char_mode_and_unicode() {
        let opts = DiffOptions {
            inline: InlineMode::Char,
            ..Default::default()
        };
        let (a, b) = ("비교 마스터", "비교 마스타");
        let d = inline_diff(a, b, &opts);
        assert_eq!(ranges(a, &d.left), ["터"]);
        assert_eq!(ranges(b, &d.right), ["타"]);
    }

    #[test]
    fn ignored_whitespace_is_not_highlighted() {
        let opts = DiffOptions {
            whitespace: WhitespaceMode::Collapse,
            ..Default::default()
        };
        let d = inline_diff("  a  =  b", "a = c ", &opts);
        assert_eq!(d.left, [8..9]);
        assert_eq!(d.right, [4..5]);
    }

    #[test]
    fn equal_lines_are_fully_similar() {
        let d = inline_diff("same", "same", &DiffOptions::default());
        assert!(d.left.is_empty() && d.right.is_empty());
        assert_eq!(d.similarity, 1.0);
    }
}
