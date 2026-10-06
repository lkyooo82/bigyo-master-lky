import { useEffect, useRef, type ReactNode } from "react";
import type { SyncAction } from "./folderTree";

/** Actions listed before the rest are summarised as a count. */
const LIST_LIMIT = 500;

const fmt = (n: number) => n.toLocaleString("ko-KR");

/** One line of the list: a mark, the path, and what happens to it. */
export interface ActionLine {
  mark: string;
  name: string;
  text: string;
  tone: "copy" | "replace" | "remove";
}

export interface ActionDialogProps {
  title: string;
  lines: ActionLine[];
  /** Counts shown next to the buttons, e.g. "복사 3개". */
  summary: string;
  /** Paths left alone, shown below the list. */
  skipped?: string[];
  /** Why paths were skipped. */
  skippedText?: string;
  /** Options above the list, such as the sync direction. */
  children?: ReactNode;
  /** True when deleting moves to the system trash. */
  trash: boolean;
  /** Why the actions can't run, if they can't. */
  blocked?: string | null;
  /** Progress while running. */
  running?: { done: number; total: number } | null;
  runLabel: string;
  /** Shown when there is nothing to do. */
  emptyText?: string;
  onRun(): void;
  onCancel(): void;
}

/** Shows what a copy, delete or sync will do and runs it after the user agrees. */
export function ActionDialog({ title, lines, summary, skipped = [], skippedText, children, trash, blocked, running, runLabel, emptyText, onRun, onCancel }: ActionDialogProps) {
  const box = useRef<HTMLDivElement>(null);
  const run = useRef<HTMLButtonElement>(null);
  // Enter runs when the run button has focus; Escape cancels from anywhere inside.
  useEffect(() => (run.current && !run.current.disabled ? run.current : box.current)?.focus(), []);
  const removes = lines.filter((l) => l.tone === "remove").length;
  const canRun = lines.length > 0 && !blocked && !running;

  return (
    <div
      className="bm-dialog-backdrop"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !running) onCancel();
        e.stopPropagation();
      }}
    >
      <div className="bm-dialog" role="dialog" aria-modal="true" aria-label={title} ref={box} tabIndex={-1}>
        <h2>{title}</h2>
        {children}
        <ul className="bm-dialog-list">
          {lines.slice(0, LIST_LIMIT).map((d, i) => (
            <li key={i} className={`bm-act-${d.tone}`}>
              <span className="bm-act-mark">{d.mark}</span>
              <span className="bm-act-path" title={d.name}>{d.name}</span>
              <span className="bm-act-what">{d.text}</span>
            </li>
          ))}
          {lines.length > LIST_LIMIT && <li className="bm-muted">외 {fmt(lines.length - LIST_LIMIT)}개</li>}
          {lines.length === 0 && <li className="bm-muted">{emptyText ?? "할 일이 없습니다. 두 폴더가 이미 맞춰져 있어요."}</li>}
        </ul>
        {skipped.length > 0 && (
          <p className="bm-muted" title={skipped.join("\n")}>
            건너뜀 {fmt(skipped.length)}개: {skippedText ?? "내용 확인이 끝나지 않았거나, 읽지 못했거나, 어느 쪽이 새것인지 알 수 없는 항목입니다."}
          </p>
        )}
        {removes > 0 && !trash && <p className="bm-error">브라우저에서는 삭제한 항목을 되살릴 수 없습니다.</p>}
        {blocked && <p className="bm-error">{blocked}</p>}
        <div className="bm-dialog-buttons">
          <span className="bm-muted">
            {running ? `진행 중 ${fmt(running.done)} / ${fmt(running.total)}` : summary}
          </span>
          <button onClick={onCancel} disabled={!!running}>취소</button>
          <button ref={run} className="bm-primary" onClick={onRun} disabled={!canRun}>
            {runLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** What a list of copies and deletions adds up to. */
export function summarize(lines: ActionLine[], trash: boolean): string {
  const removes = lines.filter((l) => l.tone === "remove").length;
  const copies = lines.length - removes;
  return [copies && `복사 ${fmt(copies)}개`, removes && `${trash ? "휴지통으로" : "삭제"} ${fmt(removes)}개`].filter(Boolean).join(" · ");
}

/** How one action reads in the list. */
export function label(a: SyncAction): ActionLine {
  const name = a.kind === "dir" ? `${a.path}/` : a.path;
  if (a.op === "remove") return { mark: "✕", name, text: `${a.side === "left" ? "왼쪽" : "오른쪽"}에서 삭제`, tone: "remove" };
  return {
    mark: a.from === "left" ? "→" : "←",
    name,
    text: `${a.from === "left" ? "오른쪽" : "왼쪽"}으로 ${a.replace ? "덮어쓰기" : "복사"}`,
    tone: a.replace ? "replace" : "copy",
  };
}
