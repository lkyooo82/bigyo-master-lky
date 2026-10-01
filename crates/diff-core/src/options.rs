/// How whitespace differences are treated when deciding whether two lines match.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum WhitespaceMode {
    /// Every whitespace character is significant.
    #[default]
    Exact,
    /// Leading and trailing whitespace is ignored.
    Trim,
    /// Runs of whitespace compare equal to a single space; leading and trailing whitespace is ignored.
    Collapse,
    /// All whitespace is ignored.
    IgnoreAll,
}

/// Granularity of the highlights inside changed lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum InlineMode {
    /// No intra-line highlights.
    None,
    /// Highlight changed words (identifier runs, whitespace runs and single punctuation).
    #[default]
    Word,
    /// Highlight changed characters.
    Char,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum Algorithm {
    /// Histogram (patience-like) diff. Usually the most readable result.
    #[default]
    Histogram,
    /// Myers diff with git/gnu-diff heuristics.
    Myers,
    /// Myers diff without heuristics; always produces a minimal edit script.
    MyersMinimal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase", default))]
pub struct DiffOptions {
    pub whitespace: WhitespaceMode,
    pub ignore_case: bool,
    /// Treat `\r\n` and `\n` line endings as equal.
    pub ignore_line_endings: bool,
    pub algorithm: Algorithm,
    pub inline: InlineMode,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            whitespace: WhitespaceMode::Exact,
            ignore_case: false,
            ignore_line_endings: true,
            algorithm: Algorithm::Histogram,
            inline: InlineMode::Word,
        }
    }
}

impl From<Algorithm> for imara_diff::Algorithm {
    fn from(a: Algorithm) -> Self {
        match a {
            Algorithm::Histogram => imara_diff::Algorithm::Histogram,
            Algorithm::Myers => imara_diff::Algorithm::Myers,
            Algorithm::MyersMinimal => imara_diff::Algorithm::MyersMinimal,
        }
    }
}
