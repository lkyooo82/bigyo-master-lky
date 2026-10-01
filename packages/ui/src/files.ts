/** A text file opened on one side. `handle` is host-specific (a path on desktop, a file handle on the web). */
export interface OpenedFile {
  name: string;
  text: string;
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

/** Reads a browser File as UTF-8; shared by both hosts for drag and drop. */
export async function readDroppedFile(data: DataTransfer): Promise<OpenedFile | null> {
  const file = data.files[0];
  if (!file) return null;
  return { name: file.name, text: await file.text() };
}
