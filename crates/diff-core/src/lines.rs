use std::borrow::Cow;

use regex_lite::Regex;

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

/// Turns lines into comparison keys, with the ignore patterns compiled once.
pub struct Keyer<'o> {
    opts: &'o DiffOptions,
    ignore: Vec<Regex>,
}

/// An ignore pattern that isn't a valid regular expression.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PatternError {
    pub pattern: String,
    pub message: String,
}

impl<'o> Keyer<'o> {
    /// Compiles `opts.ignore`; patterns that don't compile are left out and returned.
    pub fn new(opts: &'o DiffOptions) -> (Self, Vec<PatternError>) {
        let mut ignore = Vec::new();
        let mut errors = Vec::new();
        for pattern in opts.ignore.iter().filter(|p| !p.is_empty()) {
            match Regex::new(pattern) {
                Ok(re) => ignore.push(re),
                Err(e) => errors.push(PatternError {
                    pattern: pattern.clone(),
                    message: e.to_string(),
                }),
            }
        }
        (Self { opts, ignore }, errors)
    }

    /// The line with every ignored part removed.
    fn strip<'t>(&self, text: &'t str) -> Cow<'t, str> {
        let mut out = Cow::Borrowed(text);
        for re in &self.ignore {
            if let Cow::Owned(s) = re.replace_all(&out, "") {
                out = Cow::Owned(s);
            }
        }
        out
    }

    /// The comparison key for a line: two lines match when their keys are equal.
    pub fn key(&self, line: &Line<'_>) -> String {
        key_of(&self.strip(line.text), line.crlf, self.opts)
    }

    /// Whether a line doesn't matter: blank once ignored parts are removed, and either it had an
    /// ignored part or blank lines are ignored.
    pub fn unimportant(&self, line: &Line<'_>) -> bool {
        let stripped = self.strip(line.text);
        stripped.trim().is_empty() && (self.opts.ignore_blank_lines || !line.text.trim().is_empty())
    }
}

/// The comparison key for a line, ignoring `opts.ignore`; use [`Keyer`] to apply those.
pub fn line_key(line: &Line<'_>, opts: &DiffOptions) -> String {
    key_of(line.text, line.crlf, opts)
}

fn key_of(text: &str, crlf: bool, opts: &DiffOptions) -> String {
    let mut key = normalize_whitespace(text, opts.whitespace);
    if opts.ignore_case {
        key = key.to_lowercase();
    }
    if crlf && !opts.ignore_line_endings {
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

    #[test]
    fn ignore_patterns_strip_parts_of_lines() {
        let opts = DiffOptions {
            ignore: vec!["//.*".into(), "(".into()],
            whitespace: WhitespaceMode::Trim,
            ..Default::default()
        };
        let (keyer, errors) = Keyer::new(&opts);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].pattern, "(");
        let line = |text| Line { text, crlf: false };
        assert_eq!(keyer.key(&line("x = 1; // one")), "x = 1;");
        assert!(keyer.unimportant(&line("   // only a comment")));
        assert!(!keyer.unimportant(&line("")));
        assert!(!keyer.unimportant(&line("x // y")));
        let blank = DiffOptions {
            ignore_blank_lines: true,
            ..Default::default()
        };
        assert!(Keyer::new(&blank).0.unimportant(&line("  ")));
    }
}
