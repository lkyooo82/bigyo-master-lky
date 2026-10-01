import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import type { Launch } from "@bigyo/ui";

interface LaunchPath {
  path: string;
  exists: boolean;
  isDir: boolean;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Two files or two folders given on the command line (`bigyo-master left right`), as Git tools
 * such as SourceTree pass them to an external diff tool. Anything else opens the app as usual.
 */
export async function readLaunch(): Promise<Launch | undefined> {
  try {
    const paths = await invoke<LaunchPath[]>("launch_paths");
    if (paths.length === 0) return undefined;
    if (paths.length !== 2) throw new Error(`비교할 경로를 두 개 주세요. 받은 경로: ${paths.length}개`);
    const [left, right] = paths;
    if (!left.exists && !right.exists) throw new Error(`두 경로 모두 없습니다.\n${left.path}\n${right.path}`);
    if (left.isDir && right.isDir) {
      return { mode: "folder", folders: { left: { name: left.path, handle: left.path }, right: { name: right.path, handle: right.path } } };
    }
    if (left.isDir || right.isDir) throw new Error("파일은 파일끼리, 폴더는 폴더끼리 비교할 수 있습니다.");
    // A missing side is an added or deleted file: compare against nothing.
    const open = async (p: LaunchPath) =>
      p.exists ? { name: baseName(p.path), bytes: await readFile(p.path), handle: p.path } : { name: "(없음)", bytes: new Uint8Array() };
    return { mode: "file", files: { left: await open(left), right: await open(right) } };
  } catch (e) {
    await message(`명령줄로 받은 경로를 열지 못했습니다.\n${e instanceof Error ? e.message : String(e)}`, { title: "비교 마스터", kind: "error" });
    return undefined;
  }
}
