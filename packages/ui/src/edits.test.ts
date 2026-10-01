import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { linesOf, replaceLines } from "./edits";

const apply = (doc: string, start: number, end: number, lines: string[]) => {
  const state = EditorState.create({ doc });
  return state.update({ changes: replaceLines(state.doc, { start, end }, lines) }).state.doc.toString();
};

describe("replaceLines", () => {
  it("replaces a range", () => expect(apply("a\nb\nc", 1, 2, ["x", "y"])).toBe("a\nx\ny\nc"));
  it("inserts before a line", () => expect(apply("a\nb", 1, 1, ["x"])).toBe("a\nx\nb"));
  it("inserts at the end", () => expect(apply("a\nb", 2, 2, ["x"])).toBe("a\nb\nx"));
  it("deletes inner lines", () => expect(apply("a\nb\nc", 1, 2, [])).toBe("a\nc"));
  it("deletes trailing lines", () => expect(apply("a\nb\nc", 1, 3, [])).toBe("a"));
  it("deletes everything", () => expect(apply("a\nb", 0, 2, [])).toBe(""));
});

describe("linesOf", () => {
  it("returns line texts", () => expect(linesOf(Text.of(["a", "b", "c"]), { start: 1, end: 3 })).toEqual(["b", "c"]));
});
