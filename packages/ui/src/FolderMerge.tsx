import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { DiffEngine } from "@bigyo/engine";
import { decodeText, detectEol, looksBinary, type FileHost, type OpenedFile } from "./files";
import { ActionDialog, type ActionLine } from "./FolderActions";
import { CONCURRENCY, DEFAULT_EXCLUDE, fmt, fmtTime, loadGitignore, saveGitignore, useScan } from "./FolderCompare";
import {
  choicesFor,
  countMerge,
  decisionOf,
  filterMerge,
  folderDecision,
  mergeAncestors,
  mergeFolderKeys,
  mergeRows,
  mergeTrees,
  pairKey,
  pairParts,
  PARTS,
  pendingComparisons,
  pickAll,
  planMerge,
  stepUndecided,
  type Change,
  type Decision,
  type MergeAction,
  type MergeFilter,
  type MergeNode,
  type MergePart,
  type MergeRow,
  type MergeStatus,
  type MergeVerdicts,
  type Output,
} from "./folderMerge";
import { parseExclude, type Criteria, type FolderEntry, type FolderHost, type FolderRef, type Verdict } from "./folderTree";
import { buildResult } from "./mergeModel";
import { MergeView, type MergeFiles } from "./MergeView";

const ROW_HEIGHT = 22;
const OVERSCAN = 10;

const PART_NAME: Record<MergePart, string> = { left: "왼쪽", base: "기준", right: "오른쪽" };
const PART_HINT: Record<MergePart, string> = { left: "왼쪽 (내 변경)", base: "기준 (공통 조상)", right: "오른쪽 (상대 변경)" };

const STATUS_TITLE: Record<MergeStatus, string> = {
  same: "바뀌지 않음",
  left: "왼쪽만 바꿈",
  right: "오른쪽만 바꿈",
  both: "양쪽이 똑같이 바꿈",
  conflict: "충돌: 양쪽이 다르게 바꿈",
  mixed: "양쪽 변경이 섞여 있음",
  pending: "내용 확인 중",
  error: "읽을 수 없음",
};

const CHANGE_MARK: Record<Change, { mark: string; title: string }> = {
  none: { mark: "", title: "" },
  added: { mark: "+", title: "새로 생김" },
  deleted: { mark: "−", title: "지워짐" },
  modified: { mark: "≠", title: "바뀜" },
  unknown: { mark: "…", title: "내용 확인 중" },
  error: { mark: "!", title: "읽을 수 없음" },
};

/** What a decision reads as for one entry: a folder the entry is missing from means deleting it. */
function choiceLabel(n: MergeNode | null, d: Decision): string {
  if (d === "merge") return "줄 단위 병합";
  if (d === "manual") return "병합 완료";
  return n && !n[d] ? `${PART_NAME[d]} (없앰)` : PART_NAME[d];
}

const empty = (name: string): OpenedFile => ({ name, bytes: new Uint8Array() });

/** Merges one text file line by line; conflicts stay in the text between Git-style markers. */
async function mergeText(engine: DiffEngine, host: FolderHost, refs: Record<MergePart, FolderRef>, n: MergeNode): Promise<{ text: string; conflicts: number }> {
  const read = (p: MergePart) => (n[p]?.kind === "file" ? host.read(refs[p], n.path) : Promise.resolve(empty("")));
  const [left, base, right] = await Promise.all([read("left"), read("base"), read("right")]);
  if ([left, base, right].some((f) => looksBinary(f.bytes, f.name))) throw new Error("바이너리 파일은 줄 단위로 병합할 수 없습니다");
  const text = (f: OpenedFile) => decodeText(f.bytes).replace(/\r\n/g, "\n");
  const inputs = { base: text(base), left: text(left), right: text(right) };
  const m = await engine.merge3(inputs.base, inputs.left, inputs.right);
  const eol = detectEol(decodeText(left.bytes));
  return { text: buildResult(m.regions, inputs).replace(/\n/g, eol), conflicts: m.stats.conflicts };
}

export interface FolderMergeFolders {
  left: FolderRef;
  base: FolderRef;
  right: FolderRef;
  /** Where the result goes; without it, the result is written into the left folder. */
  output?: FolderRef;
}

export interface FolderMergeProps {
  engine: DiffEngine;
  host: FolderHost;
  modeSwitch?: ReactNode;
  initialFolders?: FolderMergeFolders;
  active?: boolean;
}

/** Three folders, the changes each side made against the base, and one result folder. */
export function FolderMerge({ engine, host, modeSwitch, initialFolders, active = true }: FolderMergeProps) {
  const [folders, setFolders] = useState<Record<MergePart, FolderRef | null>>(() => ({
    left: initialFolders?.left ?? null,
    base: initialFolders?.base ?? null,
    right: initialFolders?.right ?? null,
  }));
  const [entries, setEntries] = useState<Record<MergePart, FolderEntry[] | null>>({ left: null, base: null, right: null });
  const [scanning, setScanning] = useState<Record<MergePart, boolean>>({ left: false, base: false, right: false });
  const [excludeText, setExcludeText] = useState(DEFAULT_EXCLUDE);
  const [exclude, setExclude] = useState(() => parseExclude(DEFAULT_EXCLUDE));
  const [criteria, setCriteria] = useState<Criteria>("content");
  const [gitignore, setGitignore] = useState(loadGitignore);
  const [filter, setFilter] = useState<MergeFilter>("all");
  const [verdicts, setVerdicts] = useState<MergeVerdicts>(() => new Map());
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [picks, setPicks] = useState<ReadonlyMap<string, Decision>>(() => new Map());
  const [output, setOutput] = useState<Output>(initialFolders?.output ? "other" : "left");
  const [otherFolder, setOtherFolder] = useState<FolderRef | null>(initialFolders?.output ?? null);
  const [dialog, setDialog] = useState(false);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rescan, setRescan] = useState(0);
  const [manual, setManual] = useState<{ id: number; path: string; files: MergeFiles } | null>(null);
  const verdictsRef = useRef(verdicts);
  verdictsRef.current = verdicts;

  const ready = !!(entries.left && entries.base && entries.right);
  const lists = useMemo(() => ({ left: entries.left ?? [], base: entries.base ?? [], right: entries.right ?? [] }), [entries]);
  const tree = useMemo(() => mergeTrees(lists, criteria, verdicts), [lists, criteria, verdicts]);
  const shown = useMemo(() => filterMerge(tree, filter), [tree, filter]);
  const rows = useMemo(() => mergeRows(shown, (key) => expanded.has(key)), [shown, expanded]);
  const counts = useMemo(() => countMerge(tree, picks), [tree, picks]);
  const selectedNode = rows.find((r) => r.node.key === selected)?.node ?? null;

  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const outRef = output === "other" ? otherFolder : folders[output];
  const canWrite = (f: FolderRef | null) => !!(f && host.copy && host.remove && host.writeText && host.canWrite?.(f));

  const scanPart = (part: MergePart) => (list: FolderEntry[] | null, busy: boolean) => {
    if (list) setEntries((e) => ({ ...e, [part]: list }));
    setScanning((s) => ({ ...s, [part]: busy }));
  };
  useScan(host, folders.left, exclude, gitignore, rescan, scanPart("left"), report);
  useScan(host, folders.base, exclude, gitignore, rescan, scanPart("base"), report);
  useScan(host, folders.right, exclude, gitignore, rescan, scanPart("right"), report);

  // Coming back from another view: files may have changed there.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && PARTS.some((p) => folders[p])) setRescan((n) => n + 1);
    wasActive.current = active;
  }, [active]);

  // Compare file contents in the background. Comparing left with right is only needed once
  // both are known to differ from the base, so this runs in rounds until nothing is left.
  useEffect(() => {
    if (!ready || !folders.left || !folders.base || !folders.right) return;
    const refs = folders as Record<MergePart, FolderRef>;
    let cancelled = false;
    const known = new Map(verdictsRef.current);
    const tried = new Set<string>();
    let done = 0;
    let total = 0;
    let batch = new Map<string, { result: Verdict; sig: string }>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (cancelled || !batch.size) return;
      const add = batch;
      batch = new Map();
      setVerdicts((v) => new Map([...v, ...add]));
      setProgress({ done, total });
    };
    void (async () => {
      for (;;) {
        const queue = pendingComparisons(mergeTrees(lists, criteria, known)).filter((c) => !tried.has(pairKey(c.path, c.pair)));
        if (!queue.length || cancelled) break;
        for (const c of queue) tried.add(pairKey(c.path, c.pair));
        total += queue.length;
        setProgress({ done, total });
        const worker = async () => {
          for (let c = queue.shift(); c && !cancelled; c = queue.shift()) {
            const [a, b] = pairParts(c.pair);
            let result: Verdict;
            try {
              result = (await host.sameContent(refs[a], refs[b], c.path)) ? "same" : "different";
            } catch {
              result = "error";
            }
            done++;
            const v = { result, sig: c.sig };
            known.set(pairKey(c.path, c.pair), v);
            batch.set(pairKey(c.path, c.pair), v);
            timer ??= setTimeout(flush, 250);
          }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      }
      clearTimeout(timer);
      flush();
      if (!cancelled) setProgress({ done, total });
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lists, criteria, folders, host]);

  const choose = (part: MergePart, folder: FolderRef) => {
    setFolders((f) => ({ ...f, [part]: folder }));
    setEntries((e) => ({ ...e, [part]: null }));
    setVerdicts(new Map());
    setPicks(new Map());
    setSelected(null);
    setNotice(null);
  };

  const pick = (part: MergePart) => {
    setError(null);
    host
      .pick()
      .then((folder) => folder && choose(part, folder))
      .catch(report);
  };

  const pickOutput = () => {
    setError(null);
    host
      .pick()
      .then((folder) => {
        if (!folder) return;
        setOtherFolder(folder);
        setOutput("other");
      })
      .catch(report);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!host.fromDrop) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const part = PARTS[Math.min(2, Math.floor(((e.clientX - rect.left) / rect.width) * 3))];
    setError(null);
    host
      .fromDrop(e.dataTransfer)
      .then((folder) => folder && choose(part, folder))
      .catch(report);
  };

  const toggle = (key: string, open?: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (open ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });

  const decide = (n: MergeNode, d: Decision) => setPicks((p) => pickAll(n, d, p));

  const go = (dir: 1 | -1) => {
    const every = mergeRows(shown);
    const i = stepUndecided(every, selected, dir, picks);
    if (i < 0) return;
    const key = every[i].node.key;
    const parents = mergeAncestors(every, key);
    if (parents.some((p) => !expanded.has(p))) setExpanded((s) => new Set([...s, ...parents]));
    setSelected(key);
  };

  /** Opens one file in the three-way merge view; saving writes it into the result folder. */
  const openManual = (n: MergeNode) => {
    if (n.kind === "dir") return toggle(n.key);
    setError(null);
    if (n.clash) return setError("파일과 폴더가 엇갈린 항목은 왼쪽·기준·오른쪽 중 하나를 고르세요.");
    if (!n.left && !n.right) return setError("양쪽 모두 지운 파일입니다.");
    const out = outRef;
    if (!out) return setError("결과를 쓸 폴더를 먼저 고르세요.");
    if (!canWrite(out)) return setError(`결과 폴더 "${out.name}"에 쓸 수 없습니다. 끌어다 놓거나 업로드한 폴더라면 "폴더 열기"로 다시 여세요.`);
    const refs = folders as Record<MergePart, FolderRef>;
    const read = (p: MergePart) => (n[p] ? host.read(refs[p], n.path) : Promise.resolve(empty(`(${PART_NAME[p]}에 없음)`)));
    Promise.all([read("left"), read("base"), read("right")])
      .then(([left, base, right]) =>
        setManual((m) => ({ id: (m?.id ?? 0) + 1, path: n.path, files: { left, base, right, result: { name: `${out.name}/${n.path}` } } })),
      )
      .catch(report);
  };

  const closeManual = () => {
    const path = manual?.path;
    setManual(null);
    if (path) setVerdicts((v) => new Map([...v].filter(([k]) => k.slice(3) !== path)));
    setRescan((n) => n + 1);
  };

  const manualFiles = useMemo((): FileHost | null => {
    if (!manual || !outRef) return null;
    const out = outRef;
    const path = manual.path;
    return {
      open: async () => null,
      fromDrop: async () => null,
      async save({ text }) {
        await host.writeText!(out, path, text);
        setPicks((p) => new Map(p).set(path, "manual"));
        return { name: `${out.name}/${path}` };
      },
    };
  }, [manual, outRef, host]);

  const plan = useMemo(() => (dialog ? planMerge(tree, picks, output) : { actions: [], undecided: [] }), [dialog, tree, picks, output]);

  const nodeAt = useMemo(() => new Map(mergeRows(tree).map((r) => [r.node.path, r.node])), [tree]);
  const lines = useMemo(
    () =>
      plan.actions.map((a): ActionLine => {
        if (a.op === "merge") return { mark: "⇄", name: a.path, text: "줄 단위 병합", tone: "replace" };
        const name = a.kind === "dir" ? `${a.path}/` : a.path;
        if (a.op === "remove") return { mark: "✕", name, text: host.removesToTrash ? "휴지통으로" : "삭제", tone: "remove" };
        const n = nodeAt.get(a.path);
        const replace = output !== "other" && !!n?.[output] && n[output]!.kind === a.kind;
        return { mark: "⇢", name, text: `${PART_NAME[a.from]} 것으로 ${replace ? "덮어쓰기" : "복사"}`, tone: replace ? "replace" : "copy" };
      }),
    [plan, nodeAt, output, host],
  );
  const summary = (() => {
    const n = (op: MergeAction["op"]) => plan.actions.filter((a) => a.op === op).length;
    return [n("copy") && `복사 ${fmt(n("copy"))}개`, n("merge") && `병합 ${fmt(n("merge"))}개`, n("remove") && `${host.removesToTrash ? "휴지통으로" : "삭제"} ${fmt(n("remove"))}개`]
      .filter(Boolean)
      .join(" · ");
  })();

  const blocked = (() => {
    if (counts.pending > 0) return "아직 내용을 확인하는 파일이 있습니다. 확인이 끝난 뒤 실행하세요.";
    if (plan.undecided.length) return `어떻게 할지 고르지 않은 충돌이 ${fmt(plan.undecided.length)}개 있습니다: ${plan.undecided[0]}${plan.undecided.length > 1 ? " 외" : ""}`;
    if (!outRef) return "결과를 쓸 폴더를 고르세요.";
    if (!canWrite(outRef)) return `결과 폴더 "${outRef.name}"에 쓸 수 없습니다. 끌어다 놓거나 업로드한 폴더라면 "폴더 열기"로 다시 여세요.`;
    return null;
  })();

  const runMerge = async () => {
    const { actions } = plan;
    const out = outRef!;
    const refs = folders as Record<MergePart, FolderRef>;
    const failed: string[] = [];
    const withConflicts: string[] = [];
    const merged: string[] = [];
    setRunning({ done: 0, total: actions.length });
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      try {
        if (a.op === "copy") await host.copy!(refs[a.from], out, a.path);
        else if (a.op === "remove") await host.remove!(out, a.path);
        else {
          const r = await mergeText(engine, host, refs, nodeAt.get(a.path)!);
          await host.writeText!(out, a.path, r.text);
          merged.push(a.path);
          if (r.conflicts) withConflicts.push(a.path);
        }
      } catch (e) {
        failed.push(`${a.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      setRunning({ done: i + 1, total: actions.length });
    }
    setRunning(null);
    setDialog(false);
    // Writing into the left or right folder changes what the tree compares, so earlier picks
    // no longer apply; files merged by hand or line by line are done either way.
    setPicks((p) => {
      const keep = new Map(output === "other" ? p : [...p].filter(([, d]) => d === "manual"));
      for (const path of merged) keep.set(path, "manual");
      return keep;
    });
    const touched = actions.map((a) => a.path);
    setVerdicts((v) => new Map([...v].filter(([k]) => !touched.some((t) => k.slice(3) === t || k.slice(3).startsWith(t + "/")))));
    if (output !== "other") setRescan((n) => n + 1);
    const ok = actions.length - failed.length;
    setNotice(
      failed.length
        ? null
        : `병합을 마쳤습니다 (${fmt(ok)}개 항목)` + (withConflicts.length ? `. 충돌 표시가 남은 파일 ${fmt(withConflicts.length)}개: ${withConflicts.slice(0, 3).join(", ")}${withConflicts.length > 3 ? " 외" : ""}` : ""),
    );
    setError(failed.length ? `${fmt(failed.length)}개 실패 (${fmt(ok)}개 완료). ${failed[0]}${failed.length > 1 ? " 외" : ""}` : null);
  };

  useEffect(() => {
    if (!active || manual) return;
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      if (e.altKey && e.key === "ArrowDown") go(1);
      else if (e.altKey && e.key === "ArrowUp") go(-1);
      else if (e.altKey && e.key === "ArrowLeft" && selectedNode) decide(selectedNode, "left");
      else if (e.altKey && e.key === "ArrowRight" && selectedNode) decide(selectedNode, "right");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const i = rows.findIndex((r) => r.node.key === selected);
    const row = rows[i] as MergeRow | undefined;
    if (e.key === "ArrowDown") setSelected(rows[Math.min(rows.length - 1, i + 1)]?.node.key ?? null);
    else if (e.key === "ArrowUp") setSelected(rows[Math.max(0, i - 1)]?.node.key ?? null);
    else if (e.key === "ArrowRight" && row?.node.kind === "dir") toggle(row.node.key, true);
    else if (e.key === "ArrowLeft" && row) {
      if (row.node.kind === "dir" && expanded.has(row.node.key)) toggle(row.node.key, false);
      else if (row.parent) setSelected(row.parent);
    } else if (e.key === "Enter" && row) openManual(row.node);
    else return;
    e.preventDefault();
  };

  const applyExclude = () => {
    const next = parseExclude(excludeText);
    if (next.join("\n") !== exclude.join("\n")) setExclude(next);
  };

  const busy = PARTS.some((p) => scanning[p]);
  const left = counts.conflict + counts.error;

  return (
    <>
      <div className="bm-app" hidden={!!manual}>
        <header className="bm-toolbar">
          <strong className="bm-brand">비교 마스터</strong>
          {modeSwitch}
          <div className="bm-group">
            <button onClick={() => go(-1)} disabled={!ready} title="고르지 않은 이전 충돌 (Alt+↑)">▲ 이전 충돌</button>
            <button onClick={() => go(1)} disabled={!ready} title="고르지 않은 다음 충돌 (Alt+↓)">▼ 다음 충돌</button>
          </div>
          <div className="bm-group">
            <button onClick={() => selectedNode && decide(selectedNode, "left")} disabled={!selectedNode} title="고른 항목을 왼쪽 것으로 (Alt+←)">왼쪽 사용</button>
            <button onClick={() => selectedNode && decide(selectedNode, "right")} disabled={!selectedNode} title="고른 항목을 오른쪽 것으로 (Alt+→)">오른쪽 사용</button>
            <button onClick={() => selectedNode && openManual(selectedNode)} disabled={!selectedNode || selectedNode.kind === "dir"} title="파일을 3-way 병합 화면에서 직접 합칩니다 (Enter)">
              직접 병합…
            </button>
          </div>
          <div className="bm-group">
            <label>
              보기
              <select value={filter} onChange={(e) => setFilter(e.target.value as MergeFilter)}>
                <option value="all">모두</option>
                <option value="changes">바뀐 것만</option>
                <option value="conflicts">충돌만</option>
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
                  saveGitignore(e.target.checked);
                }}
              />
              .gitignore 따르기
            </label>
          </div>
          <div className="bm-group">
            <button onClick={() => setExpanded(new Set(mergeFolderKeys(shown)))} disabled={!rows.length}>모두 펼치기</button>
            <button onClick={() => setExpanded(new Set())} disabled={!expanded.size}>모두 접기</button>
            <button onClick={() => setRescan((n) => n + 1)} disabled={!PARTS.some((p) => folders[p]) || busy} title="폴더를 다시 읽습니다">
              새로 고침
            </button>
          </div>
        </header>

        <div className="bm-filebar bm-merge-files">
          {PARTS.map((part) => (
            <div key={part} className="bm-file">
              <button onClick={() => pick(part)}>폴더 열기</button>
              <span className="bm-filename" title={folders[part]?.name}>
                {folders[part]?.name ?? <span className="bm-muted">{PART_HINT[part]} 폴더를 여세요</span>}
              </span>
              {scanning[part] && <span className="bm-muted">읽는 중…</span>}
            </div>
          ))}
        </div>

        <main className="bm-main bm-folder-main" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <MergeList
            rows={rows}
            ready={ready}
            expanded={expanded}
            selected={selected}
            picks={picks}
            onSelect={setSelected}
            onToggle={toggle}
            onOpen={openManual}
            onDecide={decide}
            onKeyDown={onListKey}
            empty={
              PARTS.some((p) => folders[p])
                ? busy
                  ? "폴더를 읽는 중입니다…"
                  : !ready
                    ? "왼쪽, 기준, 오른쪽 폴더를 모두 여세요"
                    : filter === "all"
                      ? "폴더가 비어 있습니다"
                      : "이 보기에 해당하는 항목이 없습니다"
                : "기준(공통 조상) 폴더와, 그것을 각자 고친 왼쪽·오른쪽 폴더를 여세요" + (host.fromDrop ? ". 폴더를 끌어다 놓아도 됩니다." : ".")
            }
          />
        </main>

        <div className="bm-filebar bm-merge-resultbar">
          <div className="bm-file">
            <strong>결과</strong>
            <select value={output} onChange={(e) => (e.target.value === "other" && !otherFolder ? pickOutput() : setOutput(e.target.value as Output))} title="병합한 결과를 쓸 폴더">
              <option value="left">왼쪽 폴더에 쓰기</option>
              <option value="right">오른쪽 폴더에 쓰기</option>
              <option value="other">다른 폴더에 쓰기</option>
            </select>
            {output === "other" && <button onClick={pickOutput}>폴더 열기</button>}
            <span className="bm-filename" title={outRef?.name}>
              {outRef?.name ?? <span className="bm-muted">결과 폴더를 고르세요</span>}
            </span>
            <button className="bm-primary" onClick={() => setDialog(true)} disabled={!ready || busy || !host.copy} title="고른 대로 결과 폴더를 만듭니다">
              병합 실행…
            </button>
          </div>
        </div>

        {dialog && (
          <ActionDialog
            title="폴더 병합"
            lines={lines}
            summary={summary}
            trash={!!host.removesToTrash}
            blocked={blocked}
            running={running}
            runLabel="병합 실행"
            emptyText={output === "other" ? "결과에 넣을 항목이 없습니다." : `${PART_NAME[output]} 폴더가 이미 병합 결과와 같습니다.`}
            onRun={() => void runMerge()}
            onCancel={() => setDialog(false)}
          >
            <p className="bm-muted">
              {output === "other"
                ? `"${outRef?.name ?? "결과 폴더"}"에 병합 결과를 씁니다. 그 폴더에 원래 있던 다른 파일은 그대로 둡니다.`
                : `${PART_NAME[output]} 폴더를 병합 결과로 바꿉니다. 줄 단위 병합에서 풀리지 않은 충돌은 충돌 표시를 넣어 씁니다.`}
            </p>
          </ActionDialog>
        )}

        <footer className="bm-status">
          {error ? (
            <span className="bm-error">{error}</span>
          ) : ready ? (
            <>
              {notice && <span className="bm-notice">{notice} · </span>}
              <span className="bm-mg-text-left">왼쪽만 바뀜 {fmt(counts.left)}개</span> · <span className="bm-mg-text-right">오른쪽만 바뀜 {fmt(counts.right)}개</span> · 양쪽 같은 변경{" "}
              {fmt(counts.both)}개 ·{" "}
              <span className={counts.undecided ? "bm-fs-text-different" : undefined}>
                충돌 {fmt(left)}개{left ? (counts.undecided ? ` (고를 것 ${fmt(counts.undecided)}개)` : " (모두 고름)") : ""}
              </span>{" "}
              · 그대로 {fmt(counts.same)}개
              {counts.pending > 0 && (
                <span className="bm-muted">
                  {" "}
                  · 내용 확인 중 {fmt(progress.done)} / {fmt(progress.total)}
                </span>
              )}
            </>
          ) : (
            <span className="bm-muted">세 폴더를 모두 열면 비교를 시작합니다</span>
          )}
          <span className="bm-muted bm-right">두 번 누르거나 Enter: 파일 직접 병합</span>
        </footer>
      </div>

      {manual && manualFiles && (
        <MergeView
          key={manual.id}
          engine={engine}
          files={manualFiles}
          initial={manual.files}
          active={active}
          onDone={closeManual}
          doneHint="폴더 병합으로 돌아갑니다"
          modeSwitch={
            <button onClick={closeManual} title="폴더 병합으로 돌아갑니다">
              ← 폴더 병합
            </button>
          }
        />
      )}
    </>
  );
}

interface MergeListProps {
  rows: MergeRow[];
  ready: boolean;
  expanded: ReadonlySet<string>;
  selected: string | null;
  picks: ReadonlyMap<string, Decision>;
  onSelect(key: string): void;
  onToggle(key: string): void;
  onOpen(node: MergeNode): void;
  onDecide(node: MergeNode, d: Decision): void;
  onKeyDown(e: ReactKeyboardEvent): void;
  empty: string;
}

/** The three trees side by side with the result's source on the right. Only visible rows render. */
function MergeList({ rows, ready, expanded, selected, picks, onSelect, onToggle, onOpen, onDecide, onKeyDown, empty }: MergeListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(600);

  useEffect(() => {
    const el = scroller.current!;
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
    const open = expanded.has(node.key);
    const status = ready ? node.status : "solo";
    const leaf = node.kind === "file" || !node.children.length;
    const decided = (node.status === "conflict" || node.status === "error") && (leaf ? decisionOf(node, picks) : folderDecision(node, picks)) !== null;
    const cells = (part: MergePart) => <PartCells key={part} node={node} part={part} depth={depth} open={open} onToggle={onToggle} />;
    const change = (c: Change) => (
      <span className="bm-fs-mark" title={CHANGE_MARK[c].title}>
        {CHANGE_MARK[c].mark}
      </span>
    );
    items.push(
      <div
        key={node.key}
        className={`bm-fs-row bm-mg-row bm-mg-${status}${decided ? " bm-mg-decided" : ""}${node.key === selected ? " bm-fs-selected" : ""}`}
        style={{ top: i * ROW_HEIGHT }}
        title={ready ? STATUS_TITLE[node.status] : undefined}
        onClick={() => onSelect(node.key)}
        onDoubleClick={() => onOpen(node)}
      >
        {cells("left")}
        {change(ready ? node.leftChange : "none")}
        {cells("base")}
        {change(ready ? node.rightChange : "none")}
        {cells("right")}
        {ready ? <DecisionSelect node={node} picks={picks} onDecide={onDecide} /> : <span />}
      </div>,
    );
  }

  return (
    <div className="bm-fs bm-mg">
      <div className="bm-fs-row bm-mg-row bm-fs-header">
        {PARTS.map((part, i) => (
          <div key={part} className="bm-fs-side" style={{ gridColumn: i * 2 + 1 }}>
            <span>{PART_NAME[part]}</span>
            <span className="bm-fs-size">크기</span>
            <span className="bm-fs-time">수정 시각</span>
          </div>
        ))}
        <span className="bm-mg-decision" style={{ gridColumn: 6 }}>결과</span>
      </div>
      <div className="bm-fs-scroll" ref={scroller} tabIndex={0} onKeyDown={onKeyDown} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>{items}</div>
        {rows.length === 0 && <div className="bm-hex-empty">{empty}</div>}
      </div>
    </div>
  );
}

function PartCells({ node, part, depth, open, onToggle }: { node: MergeNode; part: MergePart; depth: number; open: boolean; onToggle(key: string): void }) {
  const entry = node[part];
  if (!entry) return <div className="bm-fs-side bm-fs-absent" />;
  const dir = entry.kind === "dir";
  return (
    <div className="bm-fs-side" title={node.path}>
      <span className="bm-fs-name" style={{ paddingLeft: depth * 16 }}>
        <span
          className="bm-fs-toggle"
          onClick={(e) => {
            if (!dir || node.kind !== "dir") return;
            e.stopPropagation();
            onToggle(node.key);
          }}
        >
          {dir && node.kind === "dir" ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="bm-fs-icon">{dir ? "📁" : "📄"}</span>
        {entry.name}
      </span>
      <span className="bm-fs-size">{dir ? "" : fmt(entry.size)}</span>
      <span className="bm-fs-time">{fmtTime(entry.modified)}</span>
    </div>
  );
}

/** Where the entry's result comes from. On a folder it sets every entry inside. */
function DecisionSelect({ node, picks, onDecide }: { node: MergeNode; picks: ReadonlyMap<string, Decision>; onDecide(n: MergeNode, d: Decision): void }) {
  const folder = node.kind === "dir" && node.children.length > 0;
  const value = folder ? folderDecision(node, picks) : decisionOf(node, picks);
  const choices: Decision[] = folder ? ["left", "right", "base", "merge"] : choicesFor(node);
  return (
    <select
      className="bm-mg-decision"
      value={value ?? ""}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => onDecide(node, e.target.value as Decision)}
      title={folder ? "이 폴더 안의 모든 항목을 한 번에 정합니다" : "결과에 넣을 내용"}
    >
      {value === null && (
        <option value="" disabled>
          고르세요
        </option>
      )}
      {value === "mixed" && (
        <option value="mixed" disabled>
          섞임
        </option>
      )}
      {value === "manual" && <option value="manual">{choiceLabel(node, "manual")}</option>}
      {choices.map((c) => (
        <option key={c} value={c}>
          {folder ? (c === "merge" ? "줄 단위 병합 (양쪽에 있는 파일)" : `모두 ${PART_NAME[c as MergePart]}`) : choiceLabel(node, c)}
        </option>
      ))}
    </select>
  );
}
