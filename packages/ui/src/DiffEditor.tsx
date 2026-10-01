import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { EditorState, type Text } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import type { DiffEngine, DiffOptions, TextDiff } from "@bigyo/engine";
import { buildDecorations, diffDecorations, setDiffDecorations, type Side } from "./decorations";
import { linesOf, replaceLines } from "./edits";

export interface DiffEditorHandle {
  setText(side: Side, text: string): void;
  getText(side: Side): string;
  goToChunk(index: number): void;
  /** Copies chunk `index` from side `from` over the other side. */
  copyChunk(index: number, from: Side): void;
  lastFocused(): Side;
}

interface Props {
  engine: DiffEngine;
  options: DiffOptions;
  currentChunk: number;
  onDiff(diff: TextDiff): void;
  onEdit(side: Side): void;
  ref?: Ref<DiffEditorHandle>;
}

const RECOMPUTE_DELAY_MS = 120;

export function DiffEditor({ engine, options, currentChunk, onDiff, onEdit, ref }: Props) {
  const hosts = { left: useRef<HTMLDivElement>(null), right: useRef<HTMLDivElement>(null) };
  const views = useRef<Record<Side, EditorView> | null>(null);
  // The latest diff and the documents it was computed from.
  const result = useRef<{ diff: TextDiff; left: Text; right: Text } | null>(null);
  const focused = useRef<Side>("left");
  const latest = useRef({ engine, options, currentChunk, onDiff, onEdit });
  latest.current = { engine, options, currentChunk, onDiff, onEdit };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const silent = useRef(false);

  const isFresh = () => {
    const v = views.current;
    const r = result.current;
    return !!v && !!r && r.left === v.left.state.doc && r.right === v.right.state.doc;
  };

  const paint = () => {
    const v = views.current;
    if (!v || !isFresh()) return;
    const { diff } = result.current!;
    for (const side of ["left", "right"] as const) {
      const view = v[side];
      const decos = buildDecorations(view.state.doc, diff, side, view.defaultLineHeight, latest.current.currentChunk);
      view.dispatch({ effects: setDiffDecorations.of(decos) });
    }
  };

  const recompute = async () => {
    const v = views.current;
    if (!v) return;
    const left = v.left.state.doc;
    const right = v.right.state.doc;
    const diff = await latest.current.engine.diffText(left.toString(), right.toString(), latest.current.options);
    // Drop results for text that has changed in the meantime; a newer run is already queued.
    if (left !== v.left.state.doc || right !== v.right.state.doc) return;
    result.current = { diff, left, right };
    paint();
    latest.current.onDiff(diff);
  };

  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(recompute, RECOMPUTE_DELAY_MS);
  };

  useEffect(() => {
    const make = (side: Side) =>
      new EditorView({
        parent: hosts[side].current!,
        state: EditorState.create({
          doc: "",
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            drawSelection(),
            history(),
            search({ top: true }),
            highlightSelectionMatches(),
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
            diffDecorations,
            EditorView.updateListener.of((u) => {
              if (u.focusChanged && u.view.hasFocus) focused.current = side;
              if (u.docChanged) {
                if (!silent.current) latest.current.onEdit(side);
                schedule();
              }
            }),
          ],
        }),
      });
    const v = { left: make("left"), right: make("right") };
    views.current = v;

    // Both sides have the same height thanks to the spacers, so scroll positions map 1:1.
    let syncing: Side | null = null;
    const sync = (from: Side, to: Side) => () => {
      if (syncing === to) return;
      syncing = from;
      v[to].scrollDOM.scrollTop = v[from].scrollDOM.scrollTop;
      v[to].scrollDOM.scrollLeft = v[from].scrollDOM.scrollLeft;
      requestAnimationFrame(() => (syncing = null));
    };
    const onLeft = sync("left", "right");
    const onRight = sync("right", "left");
    v.left.scrollDOM.addEventListener("scroll", onLeft);
    v.right.scrollDOM.addEventListener("scroll", onRight);
    schedule();
    return () => {
      clearTimeout(timer.current);
      v.left.destroy();
      v.right.destroy();
      views.current = null;
    };
  }, []);

  useEffect(schedule, [options, engine]);
  useEffect(paint, [currentChunk]);

  useImperativeHandle(ref, () => ({
    setText(side, text) {
      const view = views.current![side];
      silent.current = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
      silent.current = false;
      view.scrollDOM.scrollTop = 0;
    },
    getText: (side) => views.current![side].state.doc.toString(),
    goToChunk(index) {
      const v = views.current;
      const chunk = result.current?.diff.chunks[index];
      if (!v || !chunk) return;
      const side: Side = chunk.left.end > chunk.left.start ? "left" : "right";
      const view = v[side];
      const line = view.state.doc.line(Math.min(chunk[side].start + 1, view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    },
    copyChunk(index, from) {
      const v = views.current;
      if (!v || !isFresh()) return;
      const chunk = result.current!.diff.chunks[index];
      if (!chunk || chunk.kind === "equal") return;
      const to: Side = from === "left" ? "right" : "left";
      const lines = linesOf(v[from].state.doc, chunk[from]);
      v[to].dispatch({ changes: replaceLines(v[to].state.doc, chunk[to], lines), userEvent: "input.copy" });
    },
    lastFocused: () => focused.current,
  }));

  return (
    <div className="bm-panes">
      <div className="bm-pane" ref={hosts.left} />
      <div className="bm-pane" ref={hosts.right} />
    </div>
  );
}
