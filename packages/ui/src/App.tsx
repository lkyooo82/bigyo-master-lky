import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { defaultOptions, type DiffEngine, type DiffOptions, type TextDiff } from "@bigyo/engine";
import { DiffEditor, type DiffEditorHandle } from "./DiffEditor";
import type { Side } from "./decorations";
import { detectEol, type Eol, type FileHost, type OpenedFile } from "./files";
import { changeIndices, overviewMarks, stepChange } from "./navigation";
import { sampleLeft, sampleRight } from "./sample";

interface FileState {
  name: string;
  handle?: unknown;
  eol: Eol;
  dirty: boolean;
}

const untitled = (name: string): FileState => ({ name, eol: "\n", dirty: false });

export interface AppProps {
  engine: DiffEngine;
  files: FileHost;
}

export function App({ engine, files }: AppProps) {
  const editor = useRef<DiffEditorHandle>(null);
  const [options, setOptions] = useState<DiffOptions>(defaultOptions);
  const [diff, setDiff] = useState<TextDiff | null>(null);
  const [current, setCurrent] = useState(-1);
  const [meta, setMeta] = useState<Record<Side, FileState>>({ left: untitled("왼쪽 (예시)"), right: untitled("오른쪽 (예시)") });
  const [error, setError] = useState<string | null>(null);

  const changes = useMemo(() => changeIndices(diff), [diff]);
  const marks = useMemo(() => overviewMarks(diff), [diff]);

  useEffect(() => {
    editor.current?.setText("left", sampleLeft);
    editor.current?.setText("right", sampleRight);
  }, []);

  // Keep the current difference valid after the diff changes.
  useEffect(() => {
    if (current >= 0 && !changes.includes(current)) setCurrent(-1);
  }, [changes, current]);

  const go = useCallback(
    (dir: 1 | -1) => {
      const next = stepChange(changes, current, dir);
      if (next < 0) return;
      setCurrent(next);
      editor.current?.goToChunk(next);
    },
    [changes, current],
  );

  const copy = useCallback(
    (from: Side) => {
      if (current < 0) return;
      editor.current?.copyChunk(current, from);
    },
    [current],
  );

  const load = (side: Side, file: OpenedFile | null) => {
    if (!file) return;
    editor.current?.setText(side, file.text.replace(/\r\n/g, "\n"));
    setMeta((m) => ({ ...m, [side]: { name: file.name, handle: file.handle, eol: detectEol(file.text), dirty: false } }));
    setCurrent(-1);
  };

  const run = async (task: () => Promise<void>) => {
    try {
      setError(null);
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const open = (side: Side) => run(async () => load(side, await files.open()));

  const save = (side: Side) =>
    run(async () => {
      const m = meta[side];
      const text = editor.current!.getText(side).replace(/\n/g, m.eol);
      const saved = await files.save({ name: m.name, text, handle: m.handle });
      if (saved) setMeta((s) => ({ ...s, [side]: { ...s[side], ...saved, dirty: false } }));
    });

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const side: Side = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
    const data = e.dataTransfer;
    void run(async () => load(side, await files.fromDrop(data)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.altKey && e.key === "ArrowDown") go(1);
      else if (e.altKey && e.key === "ArrowUp") go(-1);
      else if (e.altKey && e.key === "ArrowRight") copy("left");
      else if (e.altKey && e.key === "ArrowLeft") copy("right");
      else if (mod && e.key.toLowerCase() === "s") save(editor.current?.lastFocused() ?? "left");
      else if (mod && e.key.toLowerCase() === "o") open(editor.current?.lastFocused() ?? "left");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const set = <K extends keyof DiffOptions>(key: K, value: DiffOptions[K]) => setOptions((o) => ({ ...o, [key]: value }));
  const position = current >= 0 ? changes.indexOf(current) + 1 : 0;

  return (
    <div className="bm-app">
      <header className="bm-toolbar">
        <strong className="bm-brand">비교 마스터</strong>
        <div className="bm-group">
          <button onClick={() => go(-1)} disabled={!changes.length} title="이전 차이 (Alt+↑)">▲ 이전</button>
          <button onClick={() => go(1)} disabled={!changes.length} title="다음 차이 (Alt+↓)">▼ 다음</button>
          <span className="bm-muted">{changes.length ? `${position || "-"} / ${changes.length}` : ""}</span>
        </div>
        <div className="bm-group">
          <button onClick={() => copy("left")} disabled={current < 0} title="왼쪽 내용을 오른쪽으로 (Alt+→)">→ 오른쪽으로 복사</button>
          <button onClick={() => copy("right")} disabled={current < 0} title="오른쪽 내용을 왼쪽으로 (Alt+←)">← 왼쪽으로 복사</button>
        </div>
        <div className="bm-group">
          <label>
            공백
            <select value={options.whitespace} onChange={(e) => set("whitespace", e.target.value as DiffOptions["whitespace"])}>
              <option value="exact">모두 비교</option>
              <option value="trim">앞뒤 무시</option>
              <option value="collapse">개수 무시</option>
              <option value="ignoreAll">모두 무시</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={options.ignoreCase} onChange={(e) => set("ignoreCase", e.target.checked)} />
            대소문자 무시
          </label>
          <label>
            강조
            <select value={options.inline} onChange={(e) => set("inline", e.target.value as DiffOptions["inline"])}>
              <option value="word">단어</option>
              <option value="char">글자</option>
              <option value="none">줄만</option>
            </select>
          </label>
        </div>
      </header>

      <div className="bm-filebar">
        {(["left", "right"] as const).map((side) => (
          <div key={side} className="bm-file">
            <button onClick={() => open(side)} title="열기 (Ctrl+O)">열기</button>
            <button onClick={() => save(side)} title="저장 (Ctrl+S)">저장</button>
            <span className="bm-filename" title={meta[side].name}>
              {meta[side].name}
              {meta[side].dirty ? " ●" : ""}
            </span>
            <span className="bm-muted">{meta[side].eol === "\r\n" ? "CRLF" : "LF"}</span>
          </div>
        ))}
      </div>

      <main className="bm-main" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <DiffEditor
          ref={editor}
          engine={engine}
          options={options}
          currentChunk={current}
          onDiff={setDiff}
          onEdit={(side) => setMeta((m) => (m[side].dirty ? m : { ...m, [side]: { ...m[side], dirty: true } }))}
        />
        <div className="bm-overview" aria-label="차이 위치">
          {marks.map((m) => (
            <div
              key={m.chunk}
              className={`bm-mark bm-mark-${m.kind}${m.chunk === current ? " bm-mark-current" : ""}`}
              style={{ top: `${m.top * 100}%`, height: `max(3px, ${m.height * 100}%)` }}
              onClick={() => {
                setCurrent(m.chunk);
                editor.current?.goToChunk(m.chunk);
              }}
            />
          ))}
        </div>
      </main>

      <footer className="bm-status">
        {error ? (
          <span className="bm-error">{error}</span>
        ) : !diff ? (
          "비교 중…"
        ) : diff.stats.changes === 0 ? (
          "두 내용이 같습니다"
        ) : (
          <>
            차이 {diff.stats.changes}곳 · <span className="bm-s-changed">수정 {diff.stats.modified}줄</span> ·{" "}
            <span className="bm-s-inserted">추가 {diff.stats.inserted}줄</span> ·{" "}
            <span className="bm-s-deleted">삭제 {diff.stats.deleted}줄</span>
          </>
        )}
        <span className="bm-muted bm-right">파일을 왼쪽이나 오른쪽에 끌어다 놓아도 됩니다</span>
      </footer>
    </div>
  );
}
