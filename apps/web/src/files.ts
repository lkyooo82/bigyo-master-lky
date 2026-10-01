import { readDroppedFile, type FileHost, type OpenedFile } from "@bigyo/ui";

// File System Access API (Chromium). Other browsers fall back to an <input> and a download.
interface FsHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
type FsWindow = Window & {
  showOpenFilePicker?: () => Promise<FsHandle[]>;
  showSaveFilePicker?: (o: { suggestedName: string }) => Promise<FsHandle>;
};
const fsWindow = window as FsWindow;
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export const browserFiles: FileHost = {
  async open(): Promise<OpenedFile | null> {
    if (fsWindow.showOpenFilePicker) {
      try {
        const [handle] = await fsWindow.showOpenFilePicker();
        const file = await handle.getFile();
        return { name: file.name, text: await file.text(), handle };
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
    }
    const file = await pickWithInput();
    return file && { name: file.name, text: await file.text() };
  },

  async save({ name, text, handle }) {
    try {
      let target = handle as FsHandle | undefined;
      if (!target?.createWritable && fsWindow.showSaveFilePicker) target = await fsWindow.showSaveFilePicker({ suggestedName: name });
      if (target?.createWritable) {
        const w = await target.createWritable();
        await w.write(text);
        await w.close();
        return { name: target.name, handle: target };
      }
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    return { name };
  },

  fromDrop: readDroppedFile,
};
