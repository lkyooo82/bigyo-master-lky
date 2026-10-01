import { useState } from "react";
import type { DiffEngine } from "@bigyo/engine";
import type { Side } from "./decorations";
import { FileCompare } from "./FileCompare";
import type { FileHost, OpenedFile } from "./files";
import { FolderCompare } from "./FolderCompare";
import type { FolderHost } from "./folderTree";

type Mode = "file" | "folder";

export interface AppProps {
  engine: DiffEngine;
  files: FileHost;
  folders?: FolderHost;
}

/** File compare and folder compare. Both stay mounted so switching keeps each one's state. */
export function App({ engine, files, folders }: AppProps) {
  const [mode, setMode] = useState<Mode>("file");
  // Opening a pair from folder compare starts a fresh file compare.
  const [session, setSession] = useState<{ id: number; files?: Record<Side, OpenedFile> }>({ id: 0 });

  const modeSwitch = folders && (
    <div className="bm-tabs bm-modes" role="tablist" aria-label="비교 종류">
      <button role="tab" aria-selected={mode === "file"} onClick={() => setMode("file")}>파일</button>
      <button role="tab" aria-selected={mode === "folder"} onClick={() => setMode("folder")}>폴더</button>
    </div>
  );

  return (
    <>
      <div className="bm-mode" hidden={mode !== "file"}>
        <FileCompare key={session.id} engine={engine} files={files} initial={session.files} modeSwitch={modeSwitch} active={mode === "file"} />
      </div>
      {folders && (
        <div className="bm-mode" hidden={mode !== "folder"}>
          <FolderCompare
            host={folders}
            modeSwitch={modeSwitch}
            active={mode === "folder"}
            onOpenFiles={(pair) => {
              setSession((s) => ({ id: s.id + 1, files: pair }));
              setMode("file");
            }}
          />
        </div>
      )}
    </>
  );
}
