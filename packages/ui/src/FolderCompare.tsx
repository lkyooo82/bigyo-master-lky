import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Side } from "./decorations";
import type { OpenedFile } from "./files";
import { ActionDialog } from "./FolderActions";
import { applyGitignore } from "./gitignore";
import {
  allRows,
  ancestorsOf,
  compareTrees,
  countFiles,
  filterTree,
  folderKeys,
  parseExclude,
  pendingFiles,
  planSync,
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
  type SyncAction,
  type SyncDirection,
  type Verdict,
  type Verdicts,
} from "./folderTree";

const ROW_HEIGHT = 22;
const OVERSCAN = 10;
/** Files compared at once; each comparison reads both files. */
const CONCURRENCY = 16;
const DEFAULT_EXCLUDE = ".git, node_modules";
const GITIGNORE_KEY = "bigyo.folderGitignore";

const loadGitignore = () => {
  try {
    return localStorage.getItem(GITIGNORE_KEY) === "1";
  } catch {
    return false;
  }
};
const SIDES = ["left", "right"] as const;
const otherSide = (side: Side): Side => (side === "left" ? "right" : "left");
const sideName = (side: Side) => (side === "left" ? "왼쪽" : "오른쪽");

/** An open copy, delete or sync dialog. */
type Dialog =
  | { kind: "copy"; from: Side; node: FolderNode }
  | { kind: "remove"; node: FolderNode; sides: Side[] }
  | { kind: "sync"; direction: SyncDirection; mirror: boolean };

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
  /** Folders to compare right away. */
  initialFolders?: Record<Side, FolderRef>;
  /** Keyboard shortcuts work only while this view is shown; showing it again rescans. */
  active?: boolean;
}

export function FolderCompare({ host, onOpenFiles, modeSwitch, initialFolders, active = true }: FolderCompareProps) {
  const [folders, setFolders] = useState<Record<Side, FolderRef | null>>(initialFolders ?? { left: null, right: null });
  const [entries, setEntries] = useState<Record<Side, FolderEntry[] | null>>({ left: null, right: null });
  const [scanning, setScanning] = useState<Record<Side, boolean>>({ left: false, right: false });
  const [excludeText, setExcludeText] = useState(DEFAULT_EXCLUDE);
  const [exclude, setExclude] = useState(() => parseExclude(DEFAULT_EXCLUDE));
  const [criteria, setCriteria] = useState<Criteria>("content");
  const [gitignore, setGitignore] = useState(loadGitignore);
  const [filter, setFilter] = useState<Filter>("all");
  const [verdicts, setVerdicts] = useState<Verdicts>(() => new Map());
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rescan, setRescan] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  const writable = (side: Side) => {
    const folder = folders[side];
    return !!(folder && host.copy && host.remove && host.canWrite?.(folder));
  };
  const selectedNode = rows.find((r) => r.node.key === selected)?.node ?? null;
  const canCopy = (from: Side) => !!(comparing && selectedNode?.[from] && writable(otherSide(from)));
  const canRemove = !!(selectedNode && SIDES.some((side) => selectedNode[side] && writable(side)));
  const canSync = comparing && (writable("left") || writable("right"));

  const openRemove = (node: FolderNode) => {
    const sides = SIDES.filter((side) => node[side] && writable(side));
    if (sides.length) setDialog({ kind: "remove", node, sides: sides.length === 1 ? sides : [] });
  };

  const plan = useMemo((): { actions: SyncAction[]; skipped: string[] } => {
    if (!dialog) return { actions: [], skipped: [] };
    if (dialog.kind === "sync") return planSync(tree, dialog.direction, dialog.mirror);
    const { node } = dialog;
    if (dialog.kind === "copy") {
      return { actions: [{ op: "copy", from: dialog.from, path: node.path, kind: node.kind, replace: !!node[otherSide(dialog.from)] }], skipped: [] };
    }
    return { actions: dialog.sides.map((side) => ({ op: "remove", side, path: node.path, kind: node.kind })), skipped: [] };
  }, [dialog, tree]);

  /** The sides the plan changes that can't be changed, as a message. */
  const blocked = (() => {
    const locked = SIDES.filter((side) => plan.actions.some((a) => (a.op === "copy" ? otherSide(a.from) : a.side) === side) && !writable(side));
    if (!locked.length) return null;
    return `${locked.map(sideName).join("과 ")} 폴더는 바꿀 수 없습니다.` + (host.canWrite ? " 끌어다 놓거나 업로드한 폴더라면 \"폴더 열기\"로 다시 여세요." : "");
  })();

  const runPlan = async () => {
    const { actions } = plan;
    const [left, right] = [folders.left!, folders.right!];
    const ref = (side: Side) => (side === "left" ? left : right);
    const failed: string[] = [];
    setRunning({ done: 0, total: actions.length });
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      try {
        if (a.op === "copy") await host.copy!(ref(a.from), ref(otherSide(a.from)), a.path);
        else await host.remove!(ref(a.side), a.path);
      } catch (e) {
        failed.push(`${a.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      setRunning({ done: i + 1, total: actions.length });
    }
    setRunning(null);
    setDialog(null);
    // A copy can keep the size and time the old verdict was keyed on, so compare those files again.
    const touched = actions.map((a) => a.path);
    setVerdicts((v) => new Map([...v].filter(([path]) => !touched.some((t) => path === t || path.startsWith(t + "/")))));
    setRescan((n) => n + 1);
    const ok = actions.length - failed.length;
    setNotice(failed.length ? null : `${fmt(ok)}개 항목을 처리했습니다`);
    setError(failed.length ? `${fmt(failed.length)}개 실패 (${fmt(ok)}개 완료). ${failed[0]}${failed.length > 1 ? " 외" : ""}` : null);
  };

  // List each side whenever its folder or the exclude patterns change.
  const scanSide = (side: Side) => (list: FolderEntry[] | null, busy: boolean) => {
    if (list) setEntries((e) => ({ ...e, [side]: list }));
    setScanning((s) => ({ ...s, [side]: busy }));
  };
  useScan(host, folders.left, exclude, gitignore, rescan, scanSide("left"), report);
  useScan(host, folders.right, exclude, gitignore, rescan, scanSide("right"), report);

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
    setNotice(null);
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
      if (dialog) return;
      if (e.altKey && e.key === "ArrowDown") go(1);
      else if (e.altKey && e.key === "ArrowUp") go(-1);
      else if (e.altKey && e.key === "ArrowRight" && canCopy("left")) setDialog({ kind: "copy", from: "left", node: selectedNode! });
      else if (e.altKey && e.key === "ArrowLeft" && canCopy("right")) setDialog({ kind: "copy", from: "right", node: selectedNode! });
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
    else if (e.key === "Delete" && row) openRemove(row.node);
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
          <label title="각 폴더 안의 .gitignore 파일이 무시하라고 한 파일과 폴더는 비교하지 않습니다.">
            <input
              type="checkbox"
              checked={gitignore}
              onChange={(e) => {
                setGitignore(e.target.checked);
                try {
                  localStorage.setItem(GITIGNORE_KEY, e.target.checked ? "1" : "0");
                } catch {
                  // Not remembering the choice is fine.
                }
              }}
            />
            .gitignore 따르기
          </label>
        </div>
        <div className="bm-group">
          <button onClick={() => setExpanded(new Set(folderKeys(shown)))} disabled={!rows.length}>모두 펼치기</button>
          <button onClick={() => setExpanded(new Set())} disabled={!expanded.size}>모두 접기</button>
          <button onClick={() => setRescan((n) => n + 1)} disabled={!(folders.left || folders.right) || busy} title="폴더를 다시 읽습니다">
            새로 고침
          </button>
        </div>
        {host.copy && (
          <div className="bm-group">
            <button onClick={() => setDialog({ kind: "copy", from: "left", node: selectedNode! })} disabled={!canCopy("left")} title="고른 항목을 오른쪽으로 복사 (Alt+→)">
              → 복사
            </button>
            <button onClick={() => setDialog({ kind: "copy", from: "right", node: selectedNode! })} disabled={!canCopy("right")} title="고른 항목을 왼쪽으로 복사 (Alt+←)">
              ← 복사
            </button>
            <button onClick={() => selectedNode && openRemove(selectedNode)} disabled={!canRemove} title={host.removesToTrash ? "고른 항목을 휴지통으로 (Delete)" : "고른 항목을 삭제 (Delete)"}>
              삭제
            </button>
            <button onClick={() => setDialog({ kind: "sync", direction: "toRight", mirror: false })} disabled={!canSync || busy} title="두 폴더를 한 번에 맞춥니다">
              동기화…
            </button>
          </div>
        )}
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

      {dialog && (
        <ActionDialog
          title={dialog.kind === "sync" ? "폴더 동기화" : dialog.kind === "copy" ? "복사" : "삭제"}
          actions={plan.actions}
          skipped={plan.skipped}
          trash={!!host.removesToTrash}
          blocked={blocked}
          running={running}
          runLabel={dialog.kind === "sync" ? "동기화" : dialog.kind === "copy" ? "복사" : host.removesToTrash ? "휴지통으로" : "삭제"}
          emptyText={dialog.kind === "remove" ? "지울 쪽을 고르세요." : undefined}
          onRun={() => void runPlan()}
          onCancel={() => setDialog(null)}
        >
          {dialog.kind === "sync" && <SyncOptions dialog={dialog} onChange={setDialog} />}
          {dialog.kind === "remove" && dialog.sides.length !== 1 && (
            <RemoveSides node={dialog.node} sides={dialog.sides} writable={writable} onChange={(sides) => setDialog({ ...dialog, sides })} />
          )}
        </ActionDialog>
      )}

      <footer className="bm-status">
        {error ? (
          <span className="bm-error">{error}</span>
        ) : comparing ? (
          <>
            {notice && <span className="bm-notice">{notice} · </span>}
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
  gitignore: boolean,
  rescan: number,
  update: (list: FolderEntry[] | null, busy: boolean) => void,
  report: (e: unknown) => void,
) {
  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    update(null, true);
    const text = (path: string) => host.read(folder, path).then((f) => new TextDecoder().decode(f.bytes));
    host
      .scan(folder, exclude)
      .then((list) => (gitignore ? applyGitignore(list, text) : list))
      .then((list) => !cancelled && update(list, false))
      .catch((e) => {
        if (cancelled) return;
        update(null, false);
        report(e);
      });
    return () => {
      cancelled = true;
    };
  }, [host, folder, exclude, gitignore, rescan]);
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

function SyncOptions({ dialog, onChange }: { dialog: Extract<Dialog, { kind: "sync" }>; onChange(d: Dialog): void }) {
  return (
    <div className="bm-dialog-options">
      <label>
        방향
        <select value={dialog.direction} onChange={(e) => onChange({ ...dialog, direction: e.target.value as SyncDirection })}>
          <option value="toRight">왼쪽 → 오른쪽</option>
          <option value="toLeft">오른쪽 → 왼쪽</option>
          <option value="both">양쪽 (새것으로)</option>
        </select>
      </label>
      {dialog.direction !== "both" && (
        <label title="미러: 받는 쪽에만 있는 파일과 폴더를 지워서 두 폴더를 똑같이 만듭니다.">
          <input type="checkbox" checked={dialog.mirror} onChange={(e) => onChange({ ...dialog, mirror: e.target.checked })} />
          받는 쪽에만 있는 것은 삭제 (미러)
        </label>
      )}
      <span className="bm-muted">
        {dialog.direction === "both"
          ? "한쪽에만 있는 것은 반대쪽으로, 양쪽이 다른 파일은 더 최근에 고친 쪽으로 복사합니다."
          : `${dialog.direction === "toRight" ? "왼쪽" : "오른쪽"}에서 새로 생기거나 바뀐 파일을 ${dialog.direction === "toRight" ? "오른쪽" : "왼쪽"}으로 복사합니다.`}
      </span>
    </div>
  );
}

function RemoveSides({ node, sides, writable, onChange }: { node: FolderNode; sides: Side[]; writable(side: Side): boolean; onChange(sides: Side[]): void }) {
  return (
    <div className="bm-dialog-options">
      <span>지울 쪽</span>
      {SIDES.filter((side) => node[side]).map((side) => (
        <label key={side}>
          <input
            type="checkbox"
            checked={sides.includes(side)}
            disabled={!writable(side)}
            onChange={(e) => onChange(e.target.checked ? SIDES.filter((s) => s === side || sides.includes(s)) : sides.filter((s) => s !== side))}
          />
          {sideName(side)}
        </label>
      ))}
    </div>
  );
}
