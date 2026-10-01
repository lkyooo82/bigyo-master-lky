import { describe, expect, it } from "vitest";
import { detectEol, looksBinary } from "./files";

describe("files", () => {
  it("detects binary content by NUL bytes", () => {
    expect(looksBinary(new TextEncoder().encode("plain text\n"))).toBe(false);
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
  });
  it("detects line endings", () => {
    expect(detectEol("a\r\nb")).toBe("\r\n");
    expect(detectEol("a\nb")).toBe("\n");
  });
});
