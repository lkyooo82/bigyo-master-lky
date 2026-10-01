import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Side } from "./decorations";
import type { OpenedFile } from "./files";
import {
  allRows,
  ancestorsOf,
  compareTrees,
  countFiles,
  filterTree,
  folderKeys,
  parseExclude,
  pendingFiles,
  signature,
  stepDifference,
  visibleRows,
  type Criteria,
  type Filter,
  type FolderEntry,
  type FolderHost,
  type FolderNode,
  type FolderRef,
  type Row,
  type Status,
  type Verdict,
  type Verdicts,
} from "./folderTree";

const ROW_HEIGHT = 22;
const OVERSCAN = 10;
/** Files compared at once; each comparison reads both files. */
const CONCURRENCY = 16;
const DEFAULT_EXCLUDE = ".git, node_modules";
const SIDES = ["left", "right"] as const;

const STATUS_MARK: Record<Status, { mark: string; title: string }> = {
  same: { mark: "=", title: "같음" },
  different: { mark: "≠", title: "다름" },
  leftOnly: { mark: "◀", title: "왼쪽에만 있음" },
  rightOnly: { mark: "▶", title: "오른쪽에만 있음" },
  pending: { mark: "…", title: "내용 확인 중" },
  error: { mark: "!", title: "읽을 수 없음" },
};

const fmt = (n: number) => n.toLocaleString("ko-KR");
const pad = (n: number) => String(n).padStart(2, "0");
const fmtTime = (ms: number | null | undefined) => {
  if (ms == null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export interface FolderCompareProps {
  host: FolderHost;
  /** Opens a file pair in the file view; a side the file is missing from gets an empty file. */
  onOpenFiles(files: Record<Side, OpenedFile>): void;
  modeSwitch?: ReactNode;
  /** Keyboard shortcuts work only while this view is shown; showing it again rescans. */
  active?: boolean;
}

export function FolderCompare({ host, onOpenFiles, modeSwitch, active = true }: FolderCompareProps) {
  const [folders, setFolders] = useState<Record<Side, FolderRef | null>>({ left: null, right: null });
  const [entries, setEntries] = useState<Record<Side, FolderEntry[] | null>>({ left: null, right: null });
  const [scanning, setScanning] = useState<Record<Side, boolean>>({ left: false, right: false });
  const [excludeText, setExcludeText] = useState(DEFAULT_EXCLUDE);
  const [exclude, setExclude] = useState(() => parseExclude(DEFAULT_EXCLUDE));
  const [criteria, setCriteria] = useState<Criteria>("content");
  const [filter, setFilter] = useState<Filter>("all");
  const [verdicts, setVerdicts] = useState<Verdicts>(() => new Map());
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rescan, setRescan] = useState(0);
  const verdictsRef = useRef(verdicts);
  verdictsRef.current = verdicts;

  const comparing = !!(entries.left && entries.right);
  const tree = useMemo(
    () => compareTrees(entries.left ?? [], entries.right ?? [], criteria, verdicts),
    [entries, criteria, verdicts],
  );
  const shown = useMemo(() => filterTree(tree, filter), [tree, filter]);
  const rows = useMemo(() => visibleRows(shown, expanded), [shown, expanded]);
  const counts = useMemo(() => countFiles(tree), [tree]);

  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  // List each side whenever its folder or the exclude patterns change.
  const scanSide = (side: Side) => (list: FolderEntry[] | null, busy: boolean) => {
    if (list) setEntries((e) => ({ ...e, [side]: list }));
    setScanning((s) => ({ ...s, [side]: busy }));
  };
  useScan(host, folders.left, exclude, rescan, scanSide("left"), report);
  useScan(host, folders.right, exclude, rescan, scanSide("right"), report);

  // Coming back from the file view: files may have been saved there.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && (folders.left || folders.right)) setRescan((n) => n + 1);
    wasActive.current = active;
  }, [active]);

  // Compare the contents of same-sized files in the background, a few at a time.
  useEffect(() => {
    if (!comparing || !folders.left || !folders.right) return;
    const queue = pendingFiles(compareTrees(entries.left!, entries.right!, criteria, verdictsRef.current));
    setProgress({ done: 0, total: queue.length });
    if (!queue.length) return;
    const [left, right] = [folders.left, folders.right];
    let cancelled = false;
    let done = 0;
    let batch = new Map<string, { result: Verdict; sig: string }>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (cancelled || !batch.size) return;
      const add = batch;
      batch = new Map();
      setVerdicts((v) => new Map([...v, ...add]));
      setProgress({ done, total: queue.length });
    };
    const worker = async () => {
      for (let node = queue.shift(); node && !cancelled; node = queue.shift()) {
        let result: Verdict;
        try {
          result = (await host.sameContent(left, right, node.path)) ? "same" : "different";
        } catch {
          result = "error";
        }
        done++;
        batch.set(node.path, { result, sig: signature(node.left!, node.right!) });
        timer ??= setTimeout(flush, 250);
      }
    };
    const total = queue.length;
    void Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
      clearTimeout(timer);
      flush();
      if (!cancelled) setProgress({ done: total, total });
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [entries, criteria, folders, host]);

  const pick = (side: Side) => {
    setError(null);
    host
      .pick()
      .then((folder) => folder && choose(side, folder))
      .catch(report);
  };

  const choose = (side: Side, folder: FolderRef) => {
    setFolders((f) => ({ ...f, [side]: folder }));
    setEntries((e) => ({ ...e, [side]: null }));
    setVerdicts(new Map());
    setSelected(null);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!host.fromDrop) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const side: Side = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
    setError(null);
    host
      .fromDrop(e.dataTransfer)
      .then((folder) => folder && choose(side, folder))
      .catch(report);
  };

  const toggle = (key: string, open?: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (open ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });

  const openNode = (node: FolderNode) => {
    if (node.kind === "dir") return toggle(node.key);
    const read = (side: Side): Promise<OpenedFile> => {
      const folder = folders[side];
      const entry = node[side];
      if (folder && entry?.kind === "file") return host.read(folder, node.path);
      return Promise.resolve({ name: `(${side === "left" ? "왼쪽" : "오른쪽"}에 없음)`, bytes: new Uint8Array() });
    };
    setError(null);
    Promise.all([read("left"), read("right")])
      .then(([left, right]) => onOpenFiles({ left, right }))
      .catch(report);
  };

  const go = (dir: 1 | -1) => {
    const every = allRows(shown);
    const i = stepDifference(every, selected, dir);
    if (i < 0) return;
    const key = every[i].node.key;
    const parents = ancestorsOf(every, key);
    if (parents.some((p) => !expanded.has(p))) setExpanded((s) => new Set([...s, ...parents]));
    setSelected(key);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === "ArrowDown") go(1);
      else if (e.altKey && e.key === "ArrowUp") go(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const i = rows.findIndex((r) => r.node.key === selected);
    const row = rows[i] as Row | undefined;
    if (e.key === "ArrowDown") setSelected(rows[Math.min(rows.length - 1, i + 1)]?.node.key ?? null);
    else if (e.key === "ArrowUp") setSelected(rows[Math.max(0, i - 1)]?.node.key ?? null);
    else if (e.key === "ArrowRight" && row?.node.kind === "dir") toggle(row.node.key, true);
    else if (e.key === "ArrowLeft" && row) {
      if (row.node.kind === "dir" && expanded.has(row.node.key)) toggle(row.node.key, false);
      else if (row.parent) setSelected(row.parent);
    } else if (e.key === "Enter" && row) openNode(row.node);
    else return;
    e.preventDefault();
  };

  const applyExclude = () => {
    const next = parseExclude(excludeText);
    if (next.join("\n") !== exclude.join("\n")) setExclude(next);
  };

  const busy = scanning.left || scanning.right;

  return (
    <div className="bm-app">
      <header className="bm-toolbar">
        <strong className="bm-brand">비교 마스터</strong>
        {modeSwitch}
        <div className="bm-group">
          <button onClick={() => go(-1)} disabled={!comparing} title="이전 차이 (Alt+↑)">▲ 이전</button>
          <button onClick={() => go(1)} disabled={!comparing} title="다음 차이 (Alt+↓)">▼ 다음</button>
        </div>
        <div className="bm-group">
          <label>
            보기
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">모두</option>
              <option value="diff">다른 것만</option>
              <option value="same">같은 것만</option>
              <option value="orphans">한쪽에만 있는 것</option>
            </select>
          </label>
          <label title="내용: 크기가 같은 파일은 바이트를 끝까지 비교합니다. 크기·시각: 크기와 수정 시각(2초 이내)이 같으면 같은 파일로 봅니다.">
            비교 기준
            <select value={criteria} onChange={(e) => setCriteria(e.target.value as Criteria)}>
              <option value="content">내용</option>
              <option value="quick">크기·시각</option>
            </select>
          </label>
          <label title="이름이 이 패턴과 맞는 파일과 폴더는 비교하지 않습니다. 쉼표로 구분하고 * ? 를 쓸 수 있습니다.">
            제외
            <input
              className="bm-exclude"
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              onBlur={applyExclude}
              onKeyDown={(e) => e.key === "Enter" && applyExclude()}
              placeholder="예: .git, *.log"
            />
          </label>
        </div>
        <div className="bm-group">
          <button onClick={() => setExpanded(new Set(folderKeys(shown)))} disabled={!rows.length}>모두 펼치기</button>
          <button onClick={() => setExpanded(new Set())} disabled={!expanded.size}>모두 접기</button>
          <button onClick={() => setRescan((n) => n + 1)} disabled={!(folders.left || folders.right) || busy} title="폴더를 다시 읽습니다">
            새로 고침
          </button>
        </div>
      </header>

      <div className="bm-filebar">
        {SIDES.map((side) => (
          <div key={side} className="bm-file">
            <button onClick={() => pick(side)}>폴더 열기</button>
            <span className="bm-filename" title={folders[side]?.name}>
              {folders[side]?.name ?? <span className="bm-muted">{side === "left" ? "왼쪽" : "오른쪽"} 폴더를 여세요</span>}
            </span>
            {scanning[side] && <span className="bm-muted">읽는 중…</span>}
          </div>
        ))}
      </div>

      <main className="bm-main bm-folder-main" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <FolderList
          rows={rows}
          comparing={comparing}
          expanded={expanded}
          selected={selected}
          onSelect={setSelected}
          onToggle={toggle}
          onOpen={openNode}
          onKeyDown={onListKey}
          empty={
            folders.left || folders.right
              ? busy
                ? "폴더를 읽는 중입니다…"
                : filter === "all"
                  ? "폴더가 비어 있습니다"
                  : "이 보기에 해당하는 항목이 없습니다"
              : "왼쪽과 오른쪽에 비교할 폴더를 여세요" + (host.fromDrop ? ". 폴더를 끌어다 놓아도 됩니다." : ".")
          }
        />
      </main>

      <footer className="bm-status">
        {error ? (
          <span className="bm-error">{error}</span>
        ) : comparing ? (
          <>
            <span className="bm-fs-text-different">다른 파일 {fmt(counts.different)}개</span> ·{" "}
            <span className="bm-fs-text-only">왼쪽에만 {fmt(counts.leftOnly)}개</span> ·{" "}
            <span className="bm-fs-text-only">오른쪽에만 {fmt(counts.rightOnly)}개</span> · 같은 파일 {fmt(counts.same)}개
            {counts.error > 0 && <span className="bm-error"> · 읽지 못한 파일 {fmt(counts.error)}개</span>}
            {counts.pending > 0 && (
              <span className="bm-muted">
                {" "}
                · 내용 확인 중 {fmt(progress.done)} / {fmt(progress.total)}
              </span>
            )}
          </>
        ) : (
          <span className="bm-muted">양쪽 폴더를 열면 비교를 시작합니다</span>
        )}
        <span className="bm-muted bm-right">두 번 누르거나 Enter: 파일 비교 열기</span>
      </footer>
    </div>
  );
}

function useScan(
  host: FolderHost,
  folder: FolderRef | null,
  exclude: string[],
  rescan: number,
  update: (list: FolderEntry[] | null, busy: boolean) => void,
  report: (e: unknown) => void,
) {
  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    update(null, true);
    host
      .scan(folder, exclude)
      .then((list) => !cancelled && update(list, false))
      .catch((e) => {
        if (cancelled) return;
        update(null, false);
        report(e);
      });
    return () => {
      cancelled = true;
    };
  }, [host, folder, exclude, rescan]);
}

interface FolderListProps {
  rows: Row[];
  comparing: boolean;
  expanded: ReadonlySet<string>;
  selected: string | null;
  onSelect(key: string): void;
  onToggle(key: string): void;
  onOpen(node: FolderNode): void;
  onKeyDown(e: ReactKeyboardEvent): void;
  empty: string;
}

/** Both trees side by side, one row per name. Only the visible rows are rendered. */
function FolderList({ rows, comparing, expanded, selected, onSelect, onToggle, onOpen, onKeyDown, empty }: FolderListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(600);

  useEffect(() => {
    const el = scroller.current!;
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep the selected row on screen.
  useEffect(() => {
    const el = scroller.current;
    const i = rows.findIndex((r) => r.node.key === selected);
    if (!el || i < 0) return;
    const top = i * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [selected, rows]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);
  const items = [];
  for (let i = first; i < last; i++) {
    const { node, depth } = rows[i];
    const status = comparing ? node.status : "solo";
    const mark = comparing ? STATUS_MARK[node.status] : null;
    items.push(
      <div
        key={node.key}
        className={`bm-fs-row bm-fs-${status}${node.key === selected ? " bm-fs-selected" : ""}`}
        style={{ top: i * ROW_HEIGHT }}
        onClick={() => onSelect(node.key)}
        onDoubleClick={() => onOpen(node)}
      >
        <EntryCells node={node} side="left" depth={depth} open={expanded.has(node.key)} onToggle={onToggle} />
        <span className="bm-fs-mark" title={mark?.title}>{mark?.mark}</span>
        <EntryCells node={node} side="right" depth={depth} open={expanded.has(node.key)} onToggle={onToggle} />
      </div>,
    );
  }

  return (
    <div className="bm-fs">
      <div className="bm-fs-row bm-fs-header">
        {SIDES.map((side) => (
          <div key={side} className="bm-fs-side" style={{ gridColumn: side === "left" ? 1 : 3 }}>
            <span>이름</span>
            <span className="bm-fs-size">크기</span>
            <span className="bm-fs-time">수정 시각</span>
          </div>
        ))}
      </div>
      <div className="bm-fs-scroll" ref={scroller} tabIndex={0} onKeyDown={onKeyDown} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>{items}</div>
        {rows.length === 0 && <div className="bm-hex-empty">{empty}</div>}
      </div>
    </div>
  );
}

interface EntryCellsProps {
  node: FolderNode;
  side: Side;
  depth: number;
  open: boolean;
  onToggle(key: string): void;
}

function EntryCells({ node, side, depth, open, onToggle }: EntryCellsProps) {
  const entry = node[side];
  if (!entry) return <div className="bm-fs-side bm-fs-absent" />;
  const dir = entry.kind === "dir";
  return (
    <div className={`bm-fs-side${node.newer === side ? " bm-fs-newer" : ""}`} title={node.path}>
      <span className="bm-fs-name" style={{ paddingLeft: depth * 16 }}>
        <span
          className="bm-fs-toggle"
          onClick={(e) => {
            if (!dir) return;
            e.stopPropagation();
            onToggle(node.key);
          }}
        >
          {dir ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="bm-fs-icon">{dir ? "📁" : "📄"}</span>
        {entry.name}
      </span>
      <span className="bm-fs-size">{dir ? "" : fmt(entry.size)}</span>
      <span className="bm-fs-time">{fmtTime(entry.modified)}</span>
    </div>
  );
}
