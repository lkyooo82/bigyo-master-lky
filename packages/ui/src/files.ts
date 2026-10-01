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

/** Same heuristic as git: a NUL byte near the start means the file is binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, SNIFF_BYTES).includes(0);
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
