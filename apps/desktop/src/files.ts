import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { readDroppedFile, type FileHost } from "@bigyo/ui";

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Files on disk; the handle is the absolute path, so saving writes back in place. */
export const desktopFiles: FileHost = {
  async open() {
    const path = await open({ multiple: false, directory: false });
    if (!path) return null;
    return { name: baseName(path), text: await readTextFile(path), handle: path };
  },

  async save({ name, text, handle }) {
    const path = typeof handle === "string" ? handle : await save({ defaultPath: name });
    if (!path) return null;
    await writeTextFile(path, text);
    return { name: baseName(path), handle: path };
  },

  fromDrop: readDroppedFile,
};
