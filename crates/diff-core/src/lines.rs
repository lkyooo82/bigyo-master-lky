use crate::options::{DiffOptions, WhitespaceMode};

/// A line of the input, without its terminator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Line<'a> {
    /// Line content without `\n` (and without `\r` when it precedes `\n`).
    pub text: &'a str,
    /// Whether the line was terminated by `\r\n`.
    pub crlf: bool,
}

/// Splits text into lines the same way editors number them: `"a\nb\n"` has three lines,
/// the last one empty. An empty string is a single empty line.
pub fn split_lines(text: &str) -> Vec<Line<'_>> {
    text.split('\n')
        .map(|raw| match raw.strip_suffix('\r') {
            Some(text) => Line { text, crlf: true },
            None => Line {
                text: raw,
                crlf: false,
            },
        })
        .collect()
}

/// The comparison key for a line: two lines match when their keys are equal.
pub fn line_key(line: &Line<'_>, opts: &DiffOptions) -> String {
    let mut key = normalize_whitespace(line.text, opts.whitespace);
    if opts.ignore_case {
        key = key.to_lowercase();
    }
    if line.crlf && !opts.ignore_line_endings {
        key.push('\r');
    }
    key
}

pub(crate) fn normalize_whitespace(text: &str, mode: WhitespaceMode) -> String {
    match mode {
        WhitespaceMode::Exact => text.to_owned(),
        WhitespaceMode::Trim => text.trim().to_owned(),
        WhitespaceMode::Collapse => {
            let mut out = String::with_capacity(text.len());
            for word in text.split_whitespace() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(word);
            }
            out
        }
        WhitespaceMode::IgnoreAll => text.chars().filter(|c| !c.is_whitespace()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_an_editor() {
        let lines: Vec<_> = split_lines("a\r\nb\nc")
            .iter()
            .map(|l| (l.text, l.crlf))
            .collect();
        assert_eq!(lines, [("a", true), ("b", false), ("c", false)]);
        assert_eq!(split_lines("a\n").len(), 2);
        assert_eq!(split_lines("").len(), 1);
    }

    #[test]
    fn keys_follow_options() {
        let line = Line {
            text: "  Foo   Bar ",
            crlf: true,
        };
        let mut opts = DiffOptions::default();
        assert_eq!(line_key(&line, &opts), "  Foo   Bar ");
        opts.whitespace = WhitespaceMode::Collapse;
        opts.ignore_case = true;
        assert_eq!(line_key(&line, &opts), "foo bar");
        opts.whitespace = WhitespaceMode::IgnoreAll;
        opts.ignore_line_endings = false;
        assert_eq!(line_key(&line, &opts), "foobar\r");
    }
}
