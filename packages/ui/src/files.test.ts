import { describe, expect, it } from "vitest";
import { detectEol, looksBinary } from "./files";

describe("files", () => {
  it("detects binary content by NUL bytes", () => {
    expect(looksBinary(new TextEncoder().encode("plain text\n"))).toBe(false);
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
  });
  it("treats 0xFF-padded firmware without NUL bytes as binary", () => {
    const fw = new Uint8Array(4096).fill(0xff);
    fw.set([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc], 16);
    expect(looksBinary(fw, "firmware.img2")).toBe(true);
  });

  it("decides by extension", () => {
    expect(looksBinary(new TextEncoder().encode("looks like text"), "data.bin")).toBe(true);
    expect(looksBinary(new TextEncoder().encode("looks like text"), "notes.txt")).toBe(false);
  });

  it("keeps UTF-8 and legacy Korean (CP949) text as text", () => {
    expect(looksBinary(new TextEncoder().encode("비교 마스터\n".repeat(500)), "a.txt")).toBe(false);
    // "비교" in CP949, repeated, with line breaks: invalid UTF-8 but not binary.
    const cp949 = new Uint8Array(Array.from({ length: 300 }, () => [0xba, 0xf1, 0xb1, 0xb3, 0x0d, 0x0a]).flat());
    expect(looksBinary(cp949, "old.txt")).toBe(false);
  });

  it("allows a UTF-8 character cut off by the sample limit", () => {
    const text = new TextEncoder().encode("가".repeat(3000)); // 9000 bytes; 8000 cuts a character
    expect(looksBinary(text, "a.txt")).toBe(false);
  });

  it("detects line endings", () => {
    expect(detectEol("a\r\nb")).toBe("\r\n");
    expect(detectEol("a\nb")).toBe("\n");
  });
});
