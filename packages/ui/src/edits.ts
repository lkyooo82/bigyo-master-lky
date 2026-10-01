import type { ChangeSpec, Text } from "@codemirror/state";
import type { Span } from "@bigyo/engine";

export function linesOf(doc: Text, span: Span): string[] {
  const out: string[] = [];
  for (let n = span.start + 1; n <= span.end; n++) out.push(doc.line(n).text);
  return out;
}

/** The change that replaces the 0-based line range `span` of `doc` with `lines`. */
export function replaceLines(doc: Text, span: Span, lines: string[]): ChangeSpec {
  const text = lines.join("\n");
  if (span.start < span.end) {
    const from = doc.line(span.start + 1).from;
    if (lines.length > 0) return { from, to: doc.line(span.end).to, insert: text };
    // Removing lines also removes one line break.
    if (span.end < doc.lines) return { from, to: doc.line(span.end + 1).from };
    return span.start > 0 ? { from: doc.line(span.start).to, to: doc.length } : { from: 0, to: doc.length };
  }
  if (lines.length === 0) return [];
  if (span.start < doc.lines) return { from: doc.line(span.start + 1).from, insert: text + "\n" };
  return { from: doc.length, insert: "\n" + text };
}
