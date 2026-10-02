import { StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { TextDiff } from "@bigyo/engine";

export type Side = "left" | "right";

/** Fills the space where the other side has lines this side doesn't, so both sides stay aligned. */
export class SpacerWidget extends WidgetType {
  constructor(readonly lines: number, readonly lineHeight: number) {
    super();
  }
  eq(other: SpacerWidget) {
    return other.lines === this.lines && other.lineHeight === this.lineHeight;
  }
  get estimatedHeight() {
    return this.lines * this.lineHeight;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "bm-spacer";
    el.style.height = `${this.lines * this.lineHeight}px`;
    return el;
  }
}

const lineDeco = (cls: string) => Decoration.line({ class: cls });
const changed = lineDeco("bm-line bm-changed");
const inserted = lineDeco("bm-line bm-inserted");
const deleted = lineDeco("bm-line bm-deleted");
const unimportant = lineDeco("bm-line bm-unimportant");
const current = lineDeco("bm-current");
const inlineMark = Decoration.mark({ class: "bm-inline" });

/** Builds the highlights for one side. `doc` must be the text the diff was computed from. */
export function buildDecorations(doc: Text, diff: TextDiff, side: Side, lineHeight: number, currentChunk: number): DecorationSet {
  const other: Side = side === "left" ? "right" : "left";
  const lineKey = side === "left" ? "leftLine" : "rightLine";
  const rangeKey = side === "left" ? "leftRanges" : "rightRanges";
  const lonely = side === "left" ? deleted : inserted;
  const paired = new Set(diff.pairs.map((p) => p[lineKey]));
  const out: Range<Decoration>[] = [];

  diff.chunks.forEach((chunk, index) => {
    if (chunk.kind === "equal") return;
    const mine = chunk[side];
    for (let n = mine.start; n < mine.end; n++) {
      const from = doc.line(n + 1).from;
      out.push((chunk.unimportant ? unimportant : paired.has(n) ? changed : lonely).range(from));
      if (index === currentChunk) out.push(current.range(from));
    }
    const deficit = chunk[other].end - chunk[other].start - (mine.end - mine.start);
    if (deficit > 0) {
      const widget = Decoration.widget({ widget: new SpacerWidget(deficit, lineHeight), block: true, side: 1 });
      if (mine.end > mine.start) out.push(widget.range(doc.line(mine.end).to));
      else if (mine.start < doc.lines) out.push(Decoration.widget({ widget: new SpacerWidget(deficit, lineHeight), block: true, side: -1 }).range(doc.line(mine.start + 1).from));
      else out.push(widget.range(doc.length));
    }
  });

  for (const pair of diff.pairs) {
    const line = doc.line(pair[lineKey] + 1);
    for (const r of pair[rangeKey]) {
      const from = Math.min(line.from + r.start, line.to);
      const to = Math.min(line.from + r.end, line.to);
      if (to > from) out.push(inlineMark.range(from, to));
    }
  }
  return Decoration.set(out, true);
}

export const setDiffDecorations = StateEffect.define<DecorationSet>();

/** Holds the diff highlights; between recomputations they move along with edits. */
export const diffDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDiffDecorations)) return e.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
