import { useEffect, useMemo, useRef, useState } from "react";
import type { BinaryDiff } from "@bigyo/engine";
import { BYTES_PER_ROW, asciiChar, hexByte, hexLayout, hexOffset, rowCells, rowOfChunk, type HexCell } from "./hexLayout";

const ROW_HEIGHT = 20;
/** Browsers cap element height (~33M px); beyond this the scrollbar is scaled. */
const MAX_SCROLL_HEIGHT = 10_000_000;
const OVERSCAN = 8;

interface Props {
  left: Uint8Array;
  right: Uint8Array;
  diff: BinaryDiff;
  currentChunk: number;
}

const COLUMNS = Array.from({ length: BYTES_PER_ROW }, (_, i) => hexByte(i));

/** Read-only side-by-side hex dump. Only the visible rows are rendered, so file size doesn't matter. */
export function HexView({ left, right, diff, currentChunk }: Props) {
  const layout = useMemo(() => hexLayout(diff), [diff]);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(600);

  const fullHeight = layout.rows * ROW_HEIGHT;
  const height = Math.min(fullHeight, MAX_SCROLL_HEIGHT);
  // Maps the (possibly scaled) scroll position to a pixel offset in the full list.
  const scale = fullHeight > height ? (fullHeight - viewHeight) / Math.max(1, height - viewHeight) : 1;
  const virtualTop = scrollTop * scale;
  const firstRow = Math.max(0, Math.floor(virtualTop / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(layout.rows, Math.ceil((virtualTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);

  useEffect(() => {
    const el = scroller.current!;
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (currentChunk < 0 || !scroller.current) return;
    const target = rowOfChunk(layout, currentChunk) * ROW_HEIGHT - viewHeight / 3;
    scroller.current.scrollTop = Math.max(0, target) / scale;
  }, [currentChunk, layout]);

  const rows = [];
  for (let r = firstRow; r < lastRow; r++) {
    const cells = rowCells(diff, layout, r);
    rows.push(
      <div key={r} className="bm-hex-row" style={{ top: r * ROW_HEIGHT - virtualTop + scrollTop }}>
        <HexSide cells={cells} bytes={left} side="left" current={currentChunk} />
        <HexSide cells={cells} bytes={right} side="right" current={currentChunk} />
      </div>,
    );
  }

  return (
    <div className="bm-hex">
      <div className="bm-hex-row bm-hex-header">
        {(["left", "right"] as const).map((side) => (
          <div key={side} className="bm-hex-side">
            <span className="bm-hex-offset">오프셋</span>
            <span className="bm-hex-bytes">
              {COLUMNS.map((c) => (
                <span key={c} className="bm-hex-cell">{c}</span>
              ))}
            </span>
            <span className="bm-hex-ascii">텍스트</span>
          </div>
        ))}
      </div>
      <div className="bm-hex-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height, position: "relative" }}>{rows}</div>
        {layout.rows === 0 && <div className="bm-hex-empty">두 파일 모두 비어 있습니다</div>}
      </div>
    </div>
  );
}

function HexSide({ cells, bytes, side, current }: { cells: HexCell[]; bytes: Uint8Array; side: "left" | "right"; current: number }) {
  const first = cells.find((c) => c[side] !== null)?.[side];
  const cls = (c: HexCell) => {
    const off = c[side];
    let k = off === null ? "bm-hex-gap" : c.kind === "equal" ? "" : c.kind === "replace" ? "bm-hex-changed" : side === "left" ? "bm-hex-deleted" : "bm-hex-inserted";
    // A replace chunk can be longer on one side; the extra bytes read as inserted/deleted.
    if (off !== null && c.kind === "replace" && c[side === "left" ? "right" : "left"] === null) k = side === "left" ? "bm-hex-deleted" : "bm-hex-inserted";
    return c.chunk === current && c.kind !== "equal" ? `${k} bm-hex-current` : k;
  };
  return (
    <div className="bm-hex-side">
      <span className="bm-hex-offset">{first == null ? "" : hexOffset(first)}</span>
      <span className="bm-hex-bytes">
        {cells.map((c, i) => {
          const off = c[side];
          return (
            <span key={i} className={`bm-hex-cell ${cls(c)}`}>
              {off === null ? "  " : hexByte(bytes[off])}
            </span>
          );
        })}
      </span>
      <span className="bm-hex-ascii">
        {cells.map((c, i) => {
          const off = c[side];
          return (
            <span key={i} className={cls(c)}>
              {off === null ? " " : asciiChar(bytes[off])}
            </span>
          );
        })}
      </span>
    </div>
  );
}
