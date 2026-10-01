import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { defaultOptions, type BinaryDiff, type BinaryMode, type DiffEngine, type DiffOptions, type TextDiff } from "@bigyo/engine";
import { DiffEditor, type DiffEditorHandle } from "./DiffEditor";
import type { Side } from "./decorations";
import { decodeText, detectEol, looksBinary, type Eol, type FileHost, type OpenedFile } from "./files";
import { HexView } from "./HexView";
import { changeIndices, overviewMarks, stepChange } from "./navigation";
import { sampleLeft, sampleRight } from "./sample";

type View = "text" | "hex";

interface FileState {
  name: string;
  handle?: unknown;
  eol: Eol;
  dirty: boolean;
  /** The bytes as opened; the hex view shows these until the text is edited. */
  bytes?: Uint8Array;
  /** Binary files are not shown or saved as text. */
  binary: boolean;
}

const untitled = (name: string): FileState => ({ name, eol: "\n", dirty: false, binary: false });
const SIDES = ["left", "right"] as const;
const BINARY_PLACEHOLDER = "이 파일은 바이너리 파일이라 텍스트로 표시하지 않습니다.\n위의 \"16진수\" 보기에서 비교하세요.";

const fmt = (n: number) => n.toLocaleString("ko-KR");

export interface AppProps {
  engine: DiffEngine;
  files: FileHost;
}

export function App({ engine, files }: AppProps) {
  const editor = useRef<DiffEditorHandle>(null);
  const [view, setView] = useState<View>("text");
  const [options, setOptions] = useState<DiffOptions>(defaultOptions);
  const [binaryMode, setBinaryMode] = useState<BinaryMode>("smart");
  const [textDiff, setTextDiff] = useState<TextDiff | null>(null);
  const [hex, setHex] = useState<{ left: Uint8Array; right: Uint8Array; diff: BinaryDiff } | null>(null);
  const [textCurrent, setTextCurrent] = useState(-1);
  const [hexCurrent, setHexCurrent] = useState(-1);
  const [meta, setMeta] = useState<Record<Side, FileState>>({ left: untitled("왼쪽 (예시)"), right: untitled("오른쪽 (예시)") });
  const [error, setError] = useState<string | null>(null);

  const diff = view === "text" ? textDiff : (hex?.diff ?? null);
  const current = view === "text" ? textCurrent : hexCurrent;
  const setCurrent = view === "text" ? setTextCurrent : setHexCurrent;
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

  const run = async (task: () => Promise<void>) => {
    try {
      setError(null);
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // The hex view compares the opened bytes, or the editor text once it has been edited.
  useEffect(() => {
    if (view !== "hex") return;
    let cancelled = false;
    const bytesOf = (side: Side) => {
      const m = meta[side];
      if (m.bytes && (m.binary || !m.dirty)) return m.bytes;
      return new TextEncoder().encode(editor.current!.getText(side).replace(/\n/g, m.eol));
    };
    void run(async () => {
      const left = bytesOf("left");
      const right = bytesOf("right");
      const diff = await engine.diffBytes(left, right, { mode: binaryMode });
      if (!cancelled) setHex({ left, right, diff });
    });
    return () => {
      cancelled = true;
    };
  }, [view, meta, binaryMode, engine]);

  const goTo = (chunk: number) => {
    setCurrent(chunk);
    if (view === "text") editor.current?.goToChunk(chunk);
  };

  const go = useCallback(
    (dir: 1 | -1) => {
      const next = stepChange(changes, current, dir);
      if (next >= 0) goTo(next);
    },
    [changes, current, view],
  );

  const copy = useCallback(
    (from: Side) => {
      if (view !== "text" || textCurrent < 0) return;
      editor.current?.copyChunk(textCurrent, from);
    },
    [view, textCurrent],
  );

  const load = (side: Side, file: OpenedFile | null) => {
    if (!file) return;
    const binary = looksBinary(file.bytes);
    const text = binary ? BINARY_PLACEHOLDER : decodeText(file.bytes);
    editor.current?.setText(side, text.replace(/\r\n/g, "\n"));
    setMeta((m) => ({
      ...m,
      [side]: { name: file.name, handle: file.handle, eol: detectEol(text), dirty: false, bytes: file.bytes, binary },
    }));
    setTextCurrent(-1);
    setHexCurrent(-1);
    if (binary) setView("hex");
  };

  const open = (side: Side) => run(async () => load(side, await files.open()));

  const canSave = (side: Side) => view === "text" && !meta[side].binary;
  const save = (side: Side) =>
    run(async () => {
      if (!canSave(side)) return;
      const m = meta[side];
      const text = editor.current!.getText(side).replace(/\n/g, m.eol);
      const saved = await files.save({ name: m.name, text, handle: m.handle });
      if (saved) setMeta((s) => ({ ...s, [side]: { ...s[side], ...saved, dirty: false, bytes: undefined } }));
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
        <div className="bm-tabs" role="tablist">
          <button role="tab" aria-selected={view === "text"} onClick={() => setView("text")}>텍스트</button>
          <button role="tab" aria-selected={view === "hex"} onClick={() => setView("hex")}>16진수</button>
        </div>
        <div className="bm-group">
          <button onClick={() => go(-1)} disabled={!changes.length} title="이전 차이 (Alt+↑)">▲ 이전</button>
          <button onClick={() => go(1)} disabled={!changes.length} title="다음 차이 (Alt+↓)">▼ 다음</button>
          <span className="bm-muted">{changes.length ? `${position || "-"} / ${changes.length}` : ""}</span>
        </div>
        {view === "text" ? (
          <>
            <div className="bm-group">
              <button onClick={() => copy("left")} disabled={textCurrent < 0} title="왼쪽 내용을 오른쪽으로 (Alt+→)">→ 오른쪽으로 복사</button>
              <button onClick={() => copy("right")} disabled={textCurrent < 0} title="오른쪽 내용을 왼쪽으로 (Alt+←)">← 왼쪽으로 복사</button>
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
          </>
        ) : (
          <div className="bm-group">
            <label title="삽입 감지: 끼워 넣거나 지운 바이트를 찾아 뒤쪽을 다시 맞춥니다. 같은 위치: N번째 바이트끼리 비교합니다.">
              비교 방식
              <select value={binaryMode} onChange={(e) => setBinaryMode(e.target.value as BinaryMode)}>
                <option value="smart">삽입 감지</option>
                <option value="aligned">같은 위치</option>
              </select>
            </label>
          </div>
        )}
      </header>

      <div className="bm-filebar">
        {SIDES.map((side) => (
          <div key={side} className="bm-file">
            <button onClick={() => open(side)} title="열기 (Ctrl+O)">열기</button>
            <button
              onClick={() => save(side)}
              disabled={!canSave(side)}
              title={canSave(side) ? "저장 (Ctrl+S)" : "16진수 보기와 바이너리 파일은 아직 저장할 수 없습니다"}
            >
              저장
            </button>
            <span className="bm-filename" title={meta[side].name}>
              {meta[side].name}
              {meta[side].dirty ? " ●" : ""}
            </span>
            <span className="bm-muted">
              {view === "hex"
                ? hex
                  ? `${fmt(side === "left" ? hex.diff.stats.leftLen : hex.diff.stats.rightLen)} 바이트`
                  : ""
                : meta[side].binary
                  ? "바이너리"
                  : meta[side].eol === "\r\n"
                    ? "CRLF"
                    : "LF"}
            </span>
          </div>
        ))}
      </div>

      <main className="bm-main" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div className="bm-view" hidden={view !== "text"}>
          <DiffEditor
            ref={editor}
            engine={engine}
            options={options}
            currentChunk={textCurrent}
            onDiff={setTextDiff}
            onEdit={(side) => setMeta((m) => (m[side].dirty ? m : { ...m, [side]: { ...m[side], dirty: true } }))}
          />
        </div>
        {view === "hex" && (
          <div className="bm-view">{hex ? <HexView left={hex.left} right={hex.right} diff={hex.diff} currentChunk={hexCurrent} /> : null}</div>
        )}
        <div className="bm-overview" aria-label="차이 위치">
          {marks.map((m) => (
            <div
              key={m.chunk}
              className={`bm-mark bm-mark-${m.kind}${m.chunk === current ? " bm-mark-current" : ""}`}
              style={{ top: `${m.top * 100}%`, height: `max(3px, ${m.height * 100}%)` }}
              onClick={() => goTo(m.chunk)}
            />
          ))}
        </div>
      </main>

      <footer className="bm-status">
        {error ? <span className="bm-error">{error}</span> : <Summary view={view} textDiff={textDiff} hexDiff={hex?.diff ?? null} requested={binaryMode} />}
        <span className="bm-muted bm-right">파일을 왼쪽이나 오른쪽에 끌어다 놓아도 됩니다</span>
      </footer>
    </div>
  );
}

interface SummaryProps {
  view: View;
  textDiff: TextDiff | null;
  hexDiff: BinaryDiff | null;
  requested: BinaryMode;
}

function Summary({ view, textDiff, hexDiff, requested }: SummaryProps) {
  if (view === "text") {
    if (!textDiff) return <>비교 중…</>;
    if (textDiff.stats.changes === 0) return <>두 내용이 같습니다</>;
    const s = textDiff.stats;
    return (
      <>
        차이 {fmt(s.changes)}곳 · <span className="bm-s-changed">수정 {fmt(s.modified)}줄</span> ·{" "}
        <span className="bm-s-inserted">추가 {fmt(s.inserted)}줄</span> · <span className="bm-s-deleted">삭제 {fmt(s.deleted)}줄</span>
      </>
    );
  }
  if (!hexDiff) return <>비교 중…</>;
  if (hexDiff.stats.changes === 0) return <>두 파일의 바이트가 모두 같습니다</>;
  const s = hexDiff.stats;
  return (
    <>
      차이 {fmt(s.changes)}곳 · <span className="bm-s-changed">바뀜 {fmt(s.changed)}바이트</span> ·{" "}
      <span className="bm-s-inserted">추가 {fmt(s.inserted)}바이트</span> · <span className="bm-s-deleted">삭제 {fmt(s.deleted)}바이트</span>
      {hexDiff.mode !== requested && <span className="bm-muted"> · 파일이 커서 같은 위치끼리 비교했습니다</span>}
    </>
  );
}
