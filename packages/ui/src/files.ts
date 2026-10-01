/** A file opened on one side. `handle` is host-specific (a path on desktop, a file handle on the web). */
export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
  handle?: unknown;
}

/** Where files come from and go to; the web and desktop apps each provide one. */
export interface FileHost {
  open(): Promise<OpenedFile | null>;
  /** Writes `text`. Returns the saved name and handle, or null if the user cancelled. */
  save(file: { name: string; text: string; handle?: unknown }): Promise<{ name: string; handle?: unknown } | null>;
  /** Reads a file dropped onto a pane. */
  fromDrop(data: DataTransfer): Promise<OpenedFile | null>;
}

export type Eol = "\n" | "\r\n";

export function detectEol(text: string): Eol {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

const SNIFF_BYTES = 8000;

const BINARY_EXTENSIONS = new Set([
  "bin", "exe", "dll", "so", "dylib", "o", "obj", "a", "lib", "img", "iso", "rom", "fw",
  "zip", "gz", "7z", "rar", "tar", "jar", "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp",
  "pdf", "mp3", "mp4", "wav", "avi", "mov", "class", "pyc", "wasm", "db", "sqlite",
]);

/**
 * Whether a file should be compared as bytes rather than text: a binary extension, a NUL byte
 * near the start (git's rule), or bytes that can't be text in either UTF-8 or a legacy
 * encoding such as CP949 (control characters, 0xFF padding) making up more than 1%.
 */
export function looksBinary(bytes: Uint8Array, name = ""): boolean {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (BINARY_EXTENSIONS.has(ext)) return true;
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return true;
  if (isUtf8(head)) return false;
  let odd = 0;
  for (const b of head) {
    const control = b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b;
    if (control || b === 0x7f || b === 0x80 || b === 0xff) odd++;
  }
  return odd > head.length / 100;
}

/** Valid UTF-8, allowing a multi-byte character cut off at the end of the sample. */
function isUtf8(head: Uint8Array): boolean {
  for (let cut = 0; cut < 4 && cut <= head.length; cut++) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - cut));
      return true;
    } catch {
      // try again without the last byte(s)
    }
  }
  return false;
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Reads a dropped browser File; shared by both hosts. */
export async function readDroppedFile(data: DataTransfer): Promise<OpenedFile | null> {
  const file = data.files[0];
  if (!file) return null;
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
