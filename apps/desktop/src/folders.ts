import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import type { FolderEntry, FolderHost } from "@bigyo/ui";

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** Windows accepts `/` too, so relative paths join the same way everywhere. */
const joinPath = (root: string, path: string) => `${root.replace(/[\\/]+$/, "")}/${path}`;
const rootOf = (handle: unknown) => handle as string;

/** Folders on disk; listing and content comparison run natively in Rust. */
export const desktopFolders: FolderHost = {
  async pick() {
    const path = await open({ directory: true, multiple: false });
    return path ? { name: path, handle: path } : null;
  },

  scan(folder, exclude) {
    return invoke<FolderEntry[]>("scan_dir", { path: rootOf(folder.handle), exclude });
  },

  async read(folder, path) {
    const full = joinPath(rootOf(folder.handle), path);
    // The handle is the full path, so saving from the file view writes back in place.
    return { name: baseName(path), bytes: await readFile(full), handle: full };
  },

  sameContent(left, right, path) {
    return invoke<boolean>("files_equal", {
      left: joinPath(rootOf(left.handle), path),
      right: joinPath(rootOf(right.handle), path),
    });
  },

  canWrite: () => true,

  async copy(from, to, path) {
    await invoke<number>("copy_entry", { src: joinPath(rootOf(from.handle), path), dst: joinPath(rootOf(to.handle), path) });
  },

  remove(folder, path) {
    return invoke<void>("trash_entry", { path: joinPath(rootOf(folder.handle), path) });
  },

  removesToTrash: true,
};
