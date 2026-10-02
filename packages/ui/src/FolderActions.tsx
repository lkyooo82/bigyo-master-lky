import { useEffect, useRef, type ReactNode } from "react";
import type { SyncAction } from "./folderTree";

/** Actions listed before the rest are summarised as a count. */
const LIST_LIMIT = 500;

const fmt = (n: number) => n.toLocaleString("ko-KR");

export interface ActionDialogProps {
  title: string;
  actions: SyncAction[];
  /** Paths left alone, shown below the list. */
  skipped?: string[];
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
export function ActionDialog({ title, actions, skipped = [], children, trash, blocked, running, runLabel, emptyText, onRun, onCancel }: ActionDialogProps) {
  const box = useRef<HTMLDivElement>(null);
  const run = useRef<HTMLButtonElement>(null);
  // Enter runs when the run button has focus; Escape cancels from anywhere inside.
  useEffect(() => (run.current && !run.current.disabled ? run.current : box.current)?.focus(), []);
  const copies = actions.filter((a) => a.op === "copy").length;
  const removes = actions.length - copies;
  const canRun = actions.length > 0 && !blocked && !running;

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
          {actions.slice(0, LIST_LIMIT).map((a, i) => {
            const d = label(a);
            return (
              <li key={i} className={`bm-act-${d.tone}`}>
                <span className="bm-act-mark">{d.mark}</span>
                <span className="bm-act-path" title={d.name}>{d.name}</span>
                <span className="bm-act-what">{d.text}</span>
              </li>
            );
          })}
          {actions.length > LIST_LIMIT && <li className="bm-muted">외 {fmt(actions.length - LIST_LIMIT)}개</li>}
          {actions.length === 0 && <li className="bm-muted">{emptyText ?? "할 일이 없습니다. 두 폴더가 이미 맞춰져 있어요."}</li>}
        </ul>
        {skipped.length > 0 && (
          <p className="bm-muted" title={skipped.join("\n")}>
            건너뜀 {fmt(skipped.length)}개: 내용 확인이 끝나지 않았거나, 읽지 못했거나, 어느 쪽이 새것인지 알 수 없는 항목입니다.
          </p>
        )}
        {removes > 0 && !trash && <p className="bm-error">브라우저에서는 삭제한 항목을 되살릴 수 없습니다.</p>}
        {blocked && <p className="bm-error">{blocked}</p>}
        <div className="bm-dialog-buttons">
          <span className="bm-muted">
            {running
              ? `진행 중 ${fmt(running.done)} / ${fmt(running.total)}`
              : [copies && `복사 ${fmt(copies)}개`, removes && `${trash ? "휴지통으로" : "삭제"} ${fmt(removes)}개`].filter(Boolean).join(" · ")}
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

/** How one action reads in the list. */
export function label(a: SyncAction): { mark: string; name: string; text: string; tone: "copy" | "replace" | "remove" } {
  const name = a.kind === "dir" ? `${a.path}/` : a.path;
  if (a.op === "remove") return { mark: "✕", name, text: `${a.side === "left" ? "왼쪽" : "오른쪽"}에서 삭제`, tone: "remove" };
  return {
    mark: a.from === "left" ? "→" : "←",
    name,
    text: `${a.from === "left" ? "오른쪽" : "왼쪽"}으로 ${a.replace ? "덮어쓰기" : "복사"}`,
    tone: a.replace ? "replace" : "copy",
  };
}
