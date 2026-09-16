import { describe, expect, it } from "vitest";

import { safeExternalUrl } from "./external-url";

describe("safeExternalUrl", () => {
  it.each([
    ["https://example.test/article", "https://example.test/article"],
    ["http://example.test", "http://example.test/"],
    ["mailto:author@example.test", "mailto:author@example.test"],
  ])("normalizes an allowed external URL", (value, expected) => {
    expect(safeExternalUrl(value)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "https://user:secret@example.test/private",
    "https://example.test/unsafe\u0000value",
    "not a URL",
  ])("rejects a non-navigable or credential-bearing URL", (value) => {
    expect(safeExternalUrl(value)).toBeUndefined();
  });
});
