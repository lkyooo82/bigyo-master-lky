import { useState } from "react";
import type { DiffEngine } from "@bigyo/engine";
import type { Side } from "./decorations";
import { FileCompare } from "./FileCompare";
import type { FileHost, OpenedFile } from "./files";
import { FolderCompare } from "./FolderCompare";
import { FolderMerge, type FolderMergeFolders } from "./FolderMerge";
import { MergeView, type MergeFiles } from "./MergeView";
import type { FolderHost, FolderRef } from "./folderTree";

type Mode = "file" | "folder" | "merge" | "folderMerge";

/** What to open at startup, e.g. two paths passed on the command line by a Git tool. */
export type Launch =
  | { mode: "file"; files: Record<Side, OpenedFile> }
  | { mode: "folder"; folders: Record<Side, FolderRef> }
  | { mode: "merge"; files: MergeFiles }
  | { mode: "folderMerge"; folders: FolderMergeFolders };

export interface AppProps {
  engine: DiffEngine;
  files: FileHost;
  folders?: FolderHost;
  launch?: Launch;
  /** Closes the app; offered after a merge a Git tool started. */
  onDone?: () => void;
}

/** File and folder compare, and file and folder merge. All stay mounted so switching keeps each one's state. */
export function App({ engine, files, folders, launch, onDone }: AppProps) {
  const [mode, setMode] = useState<Mode>(launch?.mode ?? "file");
  // Opening a pair from folder compare starts a fresh file compare.
  const [session, setSession] = useState<{ id: number; files?: Record<Side, OpenedFile> }>({
    id: 0,
    files: launch?.mode === "file" ? launch.files : undefined,
  });

  const modeSwitch = (
    <div className="bm-tabs bm-modes" role="tablist" aria-label="비교 종류">
      <button role="tab" aria-selected={mode === "file"} onClick={() => setMode("file")}>파일</button>
      {folders && (
        <button role="tab" aria-selected={mode === "folder"} onClick={() => setMode("folder")}>폴더</button>
      )}
      <button role="tab" aria-selected={mode === "merge"} onClick={() => setMode("merge")}>병합</button>
      {folders && (
        <button role="tab" aria-selected={mode === "folderMerge"} onClick={() => setMode("folderMerge")}>폴더 병합</button>
      )}
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
      <div className="bm-mode" hidden={mode !== "merge"}>
        <MergeView
          engine={engine}
          files={files}
          initial={launch?.mode === "merge" ? launch.files : undefined}
          modeSwitch={modeSwitch}
          active={mode === "merge"}
          onDone={launch?.mode === "merge" ? onDone : undefined}
        />
      </div>
      {folders && (
        <div className="bm-mode" hidden={mode !== "folderMerge"}>
          <FolderMerge
            engine={engine}
            host={folders}
            initialFolders={launch?.mode === "folderMerge" ? launch.folders : undefined}
            modeSwitch={modeSwitch}
            active={mode === "folderMerge"}
          />
        </div>
      )}
    </>
  );
}
