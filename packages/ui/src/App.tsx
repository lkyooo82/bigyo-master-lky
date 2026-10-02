import { useState } from "react";
import type { DiffEngine } from "@bigyo/engine";
import type { Side } from "./decorations";
import { FileCompare } from "./FileCompare";
import type { FileHost, OpenedFile } from "./files";
import { FolderCompare } from "./FolderCompare";
import type { FolderHost, FolderRef } from "./folderTree";

type Mode = "file" | "folder";

/** What to open at startup, e.g. two paths passed on the command line by a Git tool. */
export type Launch = { mode: "file"; files: Record<Side, OpenedFile> } | { mode: "folder"; folders: Record<Side, FolderRef> };

export interface AppProps {
  engine: DiffEngine;
  files: FileHost;
  folders?: FolderHost;
  launch?: Launch;
}

/** File compare and folder compare. Both stay mounted so switching keeps each one's state. */
export function App({ engine, files, folders, launch }: AppProps) {
  const [mode, setMode] = useState<Mode>(launch?.mode ?? "file");
  // Opening a pair from folder compare starts a fresh file compare.
  const [session, setSession] = useState<{ id: number; files?: Record<Side, OpenedFile> }>({
    id: 0,
    files: launch?.mode === "file" ? launch.files : undefined,
  });

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
            initialFolders={launch?.mode === "folder" ? launch.folders : undefined}
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
