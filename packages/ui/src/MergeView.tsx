import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorState, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import type { DiffEngine, Merge3, MergeRegion } from "@bigyo/engine";
import { diffDecorations, setDiffDecorations, SpacerWidget } from "./decorations";
import { replaceLines } from "./edits";
import { decodeText, detectEol, looksBinary, type Eol, type FileHost, type OpenedFile } from "./files";
import { alignment, buildResult, findConflicts, PANES, resolution, touches, type Choice, type ConflictBlock, type Pane } from "./mergeModel";
import { mergeSample } from "./sample";

/** The three inputs, and where the result goes (a path from a Git tool, or nothing: ask on save). */
export interface MergeFiles {
  base: OpenedFile;
  left: OpenedFile;
  right: OpenedFile;
  result?: { name: string; handle?: unknown };
}

export interface MergeViewProps {
  engine: DiffEngine;
  files: FileHost;
  initial?: MergeFiles;
  modeSwitch?: ReactNode;
  active?: boolean;
  /** Offered after saving when a Git tool opened the merge: closing hands the result back. */
  onDone?: () => void;
  /** Tooltip of the close button. */
  doneHint?: string;
}

interface Input {
  name: string;
  text: string;
  eol: Eol;
}

const PANE_LABEL: Record<Pane, string> = { left: "왼쪽 (내 변경)", base: "기준 (공통 조상)", right: "오른쪽 (상대 변경)" };
const RESULT_DELAY_MS = 150;
const fmt = (n: number) => n.toLocaleString("ko-KR");

const lineClass = (cls: string) => Decoration.line({ class: cls });
const DECO = {
  change: lineClass("bm-line bm-inserted"),
  base: lineClass("bm-line bm-changed"),
  conflict: lineClass("bm-line bm-m-conflict"),
  current: lineClass("bm-current"),
  marker: lineClass("bm-m-marker"),
};

function toInput(file: OpenedFile): Input {
  const text = decodeText(file.bytes);
  return { name: file.name, text: text.replace(/\r\n/g, "\n"), eol: detectEol(text) };
}

/** Highlights for one of the three input panes, with spacers that keep the panes aligned. */
function paneDecorations(doc: Text, regions: MergeRegion[], pane: Pane, lineHeight: number, current: number | null): DecorationSet {
  const pads = alignment(regions);
  const out: Range<Decoration>[] = [];
  let conflict = 0;
  regions.forEach((r, i) => {
    if (r.kind === "conflict") conflict++;
    const span = r[pane];
    const deco = r.kind === "conflict" ? DECO.conflict : touches(r, pane) ? (pane === "base" ? DECO.base : DECO.change) : null;
    const isCurrent = r.kind === "conflict" && conflict === current;
    for (let n = span.start; n < span.end; n++) {
      const from = doc.line(n + 1).from;
      if (deco) out.push(deco.range(from));
      if (isCurrent) out.push(DECO.current.range(from));
    }
    const pad = pads[i][pane];
    if (pad > 0) {
      const widget = (side: 1 | -1) => Decoration.widget({ widget: new SpacerWidget(pad, lineHeight), block: true, side });
      if (span.end > span.start) out.push(widget(1).range(doc.line(span.end).to));
      else if (span.start < doc.lines) out.push(widget(-1).range(doc.line(span.start + 1).from));
      else out.push(widget(1).range(doc.length));
    }
  });
  return Decoration.set(out, true);
}

/** Highlights for the result: conflict blocks, and lines that differ from the base. */
function resultDecorations(doc: Text, blocks: ConflictBlock[], changed: { start: number; end: number }[], current: number | null): DecorationSet {
  const out: Range<Decoration>[] = [];
  const inBlock = new Set<number>();
  for (const b of blocks) {
    for (let n = b.start; n <= b.end; n++) {
      inBlock.add(n);
      const line = doc.line(n + 1);
      out.push(DECO.conflict.range(line.from));
      if (/^(<{7}|\|{7}|={7}|>{7})/.test(line.text)) out.push(DECO.marker.range(line.from));
      if (b.id !== null && b.id === current) out.push(DECO.current.range(line.from));
    }
  }
  for (const c of changed) {
    for (let n = c.start; n < c.end; n++) if (!inBlock.has(n) && n < doc.lines) out.push(DECO.change.range(doc.line(n + 1).from));
  }
  return Decoration.set(out, true);
}

const baseExtensions = () => [lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), search({ top: true }), highlightSelectionMatches(), diffDecorations];

export function MergeView({ engine, files, initial, modeSwitch, active = true, onDone, doneHint = "창을 닫고 Git 도구로 돌아갑니다" }: MergeViewProps) {
  const hosts = { left: useRef<HTMLDivElement>(null), base: useRef<HTMLDivElement>(null), right: useRef<HTMLDivElement>(null), result: useRef<HTMLDivElement>(null) };
  const views = useRef<Record<Pane | "result", EditorView> | null>(null);
  const [inputs, setInputs] = useState<Record<Pane, Input> | null>(null);
  const [merge, setMerge] = useState<Merge3 | null>(null);
  const [blocks, setBlocks] = useState<ConflictBlock[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [target, setTarget] = useState<{ name: string; handle?: unknown }>(initial?.result ?? { name: "merged.txt" });
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ inputs, merge, current, engine });
  latest.current = { inputs, merge, current, engine };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const silent = useRef(false);

  const conflictRegions = useMemo(() => merge?.regions.filter((r) => r.kind === "conflict") ?? [], [merge]);

  const run = async (task: () => Promise<void>) => {
    try {
      setError(null);
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Re-reads the conflict blocks and repaints the result after edits.
  const refreshResult = async () => {
    const v = views.current;
    const { inputs, current, engine } = latest.current;
    if (!v || !inputs) return;
    const doc = v.result.state.doc;
    const found = findConflicts(doc.toString());
    const diff = await engine.diffText(inputs.base.text, doc.toString(), { inline: "none" });
    if (doc !== v.result.state.doc) return;
    setBlocks(found);
    const changed = diff.chunks.filter((c) => c.kind !== "equal").map((c) => c.right);
    v.result.dispatch({ effects: setDiffDecorations.of(resultDecorations(doc, found, changed, current)) });
  };
  const scheduleResult = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void refreshResult(), RESULT_DELAY_MS);
  };

  useEffect(() => {
    const top = (pane: Pane) =>
      new EditorView({
        parent: hosts[pane].current!,
        state: EditorState.create({ doc: "", extensions: [...baseExtensions(), EditorState.readOnly.of(true)] }),
      });
    const result = new EditorView({
      parent: hosts.result.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          ...baseExtensions(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (!silent.current) {
              setDirty(true);
              setSaved(false);
            }
            scheduleResult();
          }),
        ],
      }),
    });
    const v = { left: top("left"), base: top("base"), right: top("right"), result };
    views.current = v;

    // The three input panes are aligned, so their scroll positions map 1:1.
    let syncing: Pane | null = null;
    const listeners = PANES.map((from) => {
      const onScroll = () => {
        if (syncing && syncing !== from) return;
        syncing = from;
        for (const to of PANES) {
          if (to === from) continue;
          v[to].scrollDOM.scrollTop = v[from].scrollDOM.scrollTop;
          v[to].scrollDOM.scrollLeft = v[from].scrollDOM.scrollLeft;
        }
        requestAnimationFrame(() => (syncing = null));
      };
      v[from].scrollDOM.addEventListener("scroll", onScroll);
      return onScroll;
    });

    if (initial) load({ base: toInput(initial.base), left: toInput(initial.left), right: toInput(initial.right) }, [initial.base, initial.left, initial.right]);
    else load(mergeSample);
    return () => {
      clearTimeout(timer.current);
      PANES.forEach((p, i) => v[p].scrollDOM.removeEventListener("scroll", listeners[i]));
      Object.values(v).forEach((view) => view.destroy());
      views.current = null;
    };
  }, []);

  const setDoc = (view: EditorView, text: string) => {
    silent.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
    silent.current = false;
    view.scrollDOM.scrollTop = 0;
  };

  /** Shows new inputs and starts the result over from the automatic merge. */
  function load(next: Record<Pane, Input>, raw?: OpenedFile[]) {
    void run(async () => {
      const v = views.current;
      if (!v) return;
      if (raw?.some((f) => looksBinary(f.bytes, f.name))) throw new Error("바이너리 파일은 병합할 수 없습니다.");
      const m = await engine.merge3(next.base.text, next.left.text, next.right.text);
      for (const pane of PANES) setDoc(v[pane], next[pane].text);
      setDoc(v.result, buildResult(m.regions, { base: next.base.text, left: next.left.text, right: next.right.text }));
      setInputs(next);
      setMerge(m);
      setDirty(false);
      setSaved(false);
      setCurrent(m.stats.conflicts > 0 ? 1 : null);
    });
  }

  // Repaint the input panes when the merge or the current conflict changes.
  useEffect(() => {
    const v = views.current;
    if (!v || !merge) return;
    for (const pane of PANES) {
      v[pane].dispatch({ effects: setDiffDecorations.of(paneDecorations(v[pane].state.doc, merge.regions, pane, v[pane].defaultLineHeight, current)) });
    }
    scheduleResult();
  }, [merge, current]);

  const scrollTo = (view: EditorView, line: number) => {
    const pos = view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from;
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    return pos;
  };

  const goTo = (block: ConflictBlock) => {
    const v = views.current!;
    setCurrent(block.id);
    const pos = scrollTo(v.result, block.start);
    v.result.dispatch({ selection: { anchor: pos } });
    const region = block.id !== null ? conflictRegions[block.id - 1] : undefined;
    if (region) scrollTo(v.left, region.left.start);
  };

  /** The blocks in the result right now (the `blocks` state lags edits by a moment). */
  const freshBlocks = () => (views.current ? findConflicts(views.current.result.state.doc.toString()) : []);

  /** The block the cursor is in, else the current one, else the first. */
  const activeBlock = (all: ConflictBlock[]): ConflictBlock | undefined => {
    const v = views.current;
    if (!v) return;
    const line = v.result.state.doc.lineAt(v.result.state.selection.main.head).number - 1;
    return all.find((b) => line >= b.start && line <= b.end) ?? all.find((b) => b.id === current) ?? all[0];
  };

  const step = (dir: 1 | -1) => {
    const all = freshBlocks();
    if (!all.length) return;
    const at = activeBlock(all);
    const i = at ? all.indexOf(at) : -1;
    const next = all[i < 0 ? (dir === 1 ? 0 : all.length - 1) : i + dir];
    if (next) goTo(next);
  };

  const choose = (choice: Choice) => {
    const v = views.current;
    const block = activeBlock(freshBlocks());
    if (!v || !block) return;
    const doc = v.result.state.doc;
    v.result.dispatch({ changes: replaceLines(doc, { start: block.start, end: block.end + 1 }, resolution(block, choice)), userEvent: "input.resolve" });
    // Move on to the next conflict still open.
    const rest = findConflicts(v.result.state.doc.toString());
    const next = rest.find((b) => b.id !== null && block.id !== null && b.id > block.id) ?? rest[0];
    if (next) goTo(next);
    else setCurrent(null);
  };

  const open = (pane: Pane) =>
    run(async () => {
      const file = await files.open();
      if (!file || !inputs) return;
      if (looksBinary(file.bytes, file.name)) throw new Error("바이너리 파일은 병합할 수 없습니다.");
      load({ ...inputs, [pane]: toInput(file) });
    });

  const save = (force = false) =>
    run(async () => {
      const v = views.current;
      if (!v || !inputs) return;
      const remaining = findConflicts(v.result.state.doc.toString()).length;
      if (remaining > 0 && !force) return setConfirmSave(true);
      setConfirmSave(false);
      const text = v.result.state.doc.toString().replace(/\n/g, inputs.left.eol);
      const done = await files.save({ name: target.name, text, handle: target.handle });
      if (!done) return;
      setTarget(done);
      setDirty(false);
      setSaved(true);
    });

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.altKey && e.key === "ArrowDown") step(1);
      else if (e.altKey && e.key === "ArrowUp") step(-1);
      else if (e.altKey && e.key === "ArrowLeft") choose("left");
      else if (e.altKey && e.key === "ArrowRight") choose("right");
      else if (mod && e.key.toLowerCase() === "s") void save();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const total = merge?.stats.conflicts ?? 0;
  const open_ = blocks.length;
  const position = current !== null ? blocks.findIndex((b) => b.id === current) + 1 : 0;

  return (
    <div className="bm-app bm-merge">
      <header className="bm-toolbar">
        <strong className="bm-brand">비교 마스터</strong>
        {modeSwitch}
        <div className="bm-group">
          <button onClick={() => step(-1)} disabled={!open_} title="이전 충돌 (Alt+↑)">▲ 이전 충돌</button>
          <button onClick={() => step(1)} disabled={!open_} title="다음 충돌 (Alt+↓)">▼ 다음 충돌</button>
          <span className="bm-muted">{open_ ? `${position || "-"} / ${open_}` : ""}</span>
        </div>
        <div className="bm-group">
          <button onClick={() => choose("left")} disabled={!open_} title="이 충돌을 왼쪽 내용으로 (Alt+←)">왼쪽 사용</button>
          <button onClick={() => choose("right")} disabled={!open_} title="이 충돌을 오른쪽 내용으로 (Alt+→)">오른쪽 사용</button>
          <button onClick={() => choose("leftRight")} disabled={!open_} title="왼쪽 다음에 오른쪽">왼쪽+오른쪽</button>
          <button onClick={() => choose("rightLeft")} disabled={!open_} title="오른쪽 다음에 왼쪽">오른쪽+왼쪽</button>
          <button onClick={() => choose("base")} disabled={!open_} title="양쪽 변경을 버리고 기준 내용으로">기준 사용</button>
        </div>
      </header>

      <div className="bm-filebar bm-merge-files">
        {PANES.map((pane) => (
          <div key={pane} className="bm-file">
            {!initial && <button onClick={() => open(pane)}>열기</button>}
            <span className="bm-muted">{PANE_LABEL[pane]}</span>
            <span className="bm-filename" title={inputs?.[pane].name}>{inputs?.[pane].name}</span>
          </div>
        ))}
      </div>

      <div className="bm-merge-inputs">
        {PANES.map((pane) => (
          <div key={pane} className="bm-pane" ref={hosts[pane]} />
        ))}
      </div>

      <div className="bm-filebar bm-merge-resultbar">
        <div className="bm-file">
          <strong>결과</strong>
          <span className="bm-filename" title={target.name}>
            {target.name}
            {dirty ? " ●" : ""}
          </span>
          {confirmSave && (
            <span className="bm-confirm">
              충돌 {fmt(open_)}개가 남아 있습니다. 충돌 표시가 남은 채로 저장할까요?
              <button onClick={() => void save(true)}>그래도 저장</button>
              <button onClick={() => setConfirmSave(false)}>취소</button>
            </span>
          )}
          <button onClick={() => void save()} title="저장 (Ctrl+S)">저장</button>
          {onDone && (
            <button onClick={onDone} className={saved ? "bm-primary" : undefined} title={doneHint}>
              {saved ? "닫기 (저장됨)" : "저장하지 않고 닫기"}
            </button>
          )}
        </div>
      </div>

      <div className="bm-merge-result bm-pane" ref={hosts.result} />

      <footer className="bm-status">
        {error ? (
          <span className="bm-error">{error}</span>
        ) : merge ? (
          <>
            {total ? (
              <span className={open_ ? "bm-s-deleted" : "bm-s-inserted"}>
                충돌 {fmt(total)}개 중 {open_ ? `${fmt(open_)}개 남음` : "모두 해결"}
              </span>
            ) : (
              <span className="bm-s-inserted">충돌 없음</span>
            )}
            <span className="bm-muted">
              · 자동 병합: 왼쪽 {fmt(merge.stats.leftChanges)}곳, 오른쪽 {fmt(merge.stats.rightChanges)}곳, 같은 변경 {fmt(merge.stats.bothChanges)}곳
            </span>
          </>
        ) : (
          <>병합 중…</>
        )}
        <span className="bm-muted bm-right">결과 창은 직접 고칠 수 있습니다</span>
      </footer>
    </div>
  );
}
