import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { latin1String, sha256Hex, utf8ByteCount } from "./sha256";

describe("runtime-agnostic sha256 and utf8 helpers", () => {
  it("matches node:crypto SHA-256 across padding boundaries, CJK text, and binary buffers", () => {
    const cases: Array<string | Uint8Array> = [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(128),
      "Quire 阅读工作台 — quiet reading 🚀",
      Uint8Array.from({ length: 257 }, (_, i) => i & 0xff),
    ];
    for (const input of cases) {
      const expected = createHash("sha256").update(input).digest("hex");
      expect(sha256Hex(input)).toBe(expected);
    }
  });

  it("matches Buffer.byteLength for ASCII, CJK, astral planes, and lone surrogates", () => {
    const strings = ["", "hello", "中文测试", "🚀🎉", "lone\ud800high", "lone\udc00low", "\ud83d\ude80mix\ud800"];
    for (const value of strings) {
      expect(utf8ByteCount(value)).toBe(Buffer.byteLength(value, "utf8"));
    }
  });

  it("matches Buffer latin1 decoding for all 256 byte values", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(latin1String(all)).toBe(Buffer.from(all).toString("latin1"));
  });
});
