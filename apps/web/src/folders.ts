import { globMatch, type FolderEntry, type FolderHost, type FolderRef, type OpenedFile } from "@bigyo/ui";

// Chromium's File System Access API reads folders in place. Other browsers fall back to
// <input webkitdirectory> or a dropped folder, which hand over every file up front.
interface FileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
interface DirHandle {
  kind: "directory";
  name: string;
  entries(): AsyncIterable<[string, FileHandle | DirHandle]>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
}
type Source = { kind: "fsa"; dir: DirHandle } | { kind: "files"; files: Map<string, File> };

type FsWindow = Window & { showDirectoryPicker?: (o?: { id?: string }) => Promise<DirHandle> };
const fsWindow = window as FsWindow;
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
const excluded = (name: string, exclude: string[]) => exclude.some((p) => globMatch(p, name));

function pickWithInput(): Promise<FolderRef | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.onchange = () => {
      const list = [...(input.files ?? [])];
      if (!list.length) return resolve(null);
      // webkitRelativePath is "picked/sub/file"; keep the part below the picked folder.
      const root = list[0].webkitRelativePath.split("/")[0];
      const files = new Map(list.map((f) => [f.webkitRelativePath.slice(root.length + 1), f]));
      resolve({ name: root, handle: { kind: "files", files } satisfies Source });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

async function scanHandle(dir: DirHandle, exclude: string[]): Promise<FolderEntry[]> {
  const work: Promise<FolderEntry>[] = [];
  for await (const [name, h] of dir.entries()) {
    if (excluded(name, exclude)) continue;
    work.push(
      h.kind === "directory"
        ? scanHandle(h, exclude).then((children) => ({ name, kind: "dir", size: 0, modified: null, children }))
        : h.getFile().then((f) => ({ name, kind: "file", size: f.size, modified: f.lastModified, children: [] })),
    );
  }
  return Promise.all(work);
}

/** Builds the tree from flat "a/b/c" paths, dropping any path with an excluded part. */
function treeOf(files: Map<string, File>, exclude: string[]): FolderEntry[] {
  const root: FolderEntry = { name: "", kind: "dir", size: 0, children: [] };
  for (const [path, f] of files) {
    const parts = path.split("/");
    if (parts.some((p) => excluded(p, exclude))) continue;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.children.find((c) => c.name === part && c.kind === "dir");
      if (!next) node.children.push((next = { name: part, kind: "dir", size: 0, modified: null, children: [] }));
      node = next;
    }
    node.children.push({ name: parts[parts.length - 1], kind: "file", size: f.size, modified: f.lastModified, children: [] });
  }
  return root.children;
}

async function fileAt(folder: FolderRef, path: string): Promise<{ file: File; handle?: FileHandle }> {
  const src = folder.handle as Source;
  if (src.kind === "files") {
    const file = src.files.get(path);
    if (!file) throw new Error(`파일을 찾을 수 없습니다: ${path}`);
    return { file };
  }
  const parts = path.split("/");
  let dir = src.dir;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  const handle = await dir.getFileHandle(parts[parts.length - 1]);
  return { file: await handle.getFile(), handle };
}

const CHUNK = 4 * 1024 * 1024;

async function sameBytes(a: File, b: File): Promise<boolean> {
  if (a.size !== b.size) return false;
  // Slicing costs more than reading for small files, which are most of a typical tree.
  const read = (f: File, at: number) => (f.size <= CHUNK ? f : f.slice(at, at + CHUNK)).arrayBuffer();
  for (let at = 0; at < a.size; at += CHUNK) {
    const [x, y] = await Promise.all([read(a, at), read(b, at)]);
    const p = new Uint8Array(x);
    const q = new Uint8Array(y);
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  }
  return true;
}

// Old-style entries API, which every browser supports for dropped folders.
interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (e: Entry[]) => void, err: (e: unknown) => void): void };
}

async function readEntries(dir: Entry, base: string, out: Map<string, File>) {
  const reader = dir.createReader!();
  for (;;) {
    // readEntries returns a batch at a time, then an empty list.
    const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
    if (!batch.length) return;
    for (const e of batch) {
      const path = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory) await readEntries(e, path, out);
      else out.set(path, await new Promise<File>((ok, err) => e.file!(ok, err)));
    }
  }
}

const notAFolder = () => new Error("폴더를 끌어다 놓으세요. 파일은 \"파일\" 비교에서 열 수 있습니다.");

export const browserFolders: FolderHost = {
  async pick() {
    if (!fsWindow.showDirectoryPicker) return pickWithInput();
    try {
      const dir = await fsWindow.showDirectoryPicker({ id: "bigyo-folder" });
      return { name: dir.name, handle: { kind: "fsa", dir } satisfies Source };
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  },

  fromDrop(data) {
    const item = data.items[0] as (DataTransferItem & { getAsFileSystemHandle?: () => Promise<DirHandle | FileHandle | null> }) | undefined;
    if (!item) return Promise.resolve(null);
    // Both calls must happen while the drop event is still being handled.
    const handle = item.getAsFileSystemHandle?.();
    const entry = item.webkitGetAsEntry() as Entry | null;
    return (async () => {
      const h = await handle;
      if (h) {
        if (h.kind !== "directory") throw notAFolder();
        return { name: h.name, handle: { kind: "fsa", dir: h } satisfies Source };
      }
      if (!entry?.isDirectory) throw notAFolder();
      const files = new Map<string, File>();
      await readEntries(entry, "", files);
      return { name: entry.name, handle: { kind: "files", files } satisfies Source };
    })();
  },

  async scan(folder, exclude) {
    const src = folder.handle as Source;
    return src.kind === "fsa" ? scanHandle(src.dir, exclude) : treeOf(src.files, exclude);
  },

  async read(folder, path): Promise<OpenedFile> {
    const { file, handle } = await fileAt(folder, path);
    return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle };
  },

  async sameContent(left, right, path) {
    const [a, b] = await Promise.all([fileAt(left, path), fileAt(right, path)]);
    return sameBytes(a.file, b.file);
  },
};
