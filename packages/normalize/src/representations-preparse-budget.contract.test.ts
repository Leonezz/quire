import { createHash } from "node:crypto";

import TurndownService from "turndown";
import { describe, expect, it, vi } from "vitest";

import { normalizeFeedCapture } from "./module";
import { createRepresentations } from "./representations";

const ERROR_CODE = "SOURCE_REPRESENTATION_BUDGET_EXCEEDED";

describe("HTML representation pre-parse budget", () => {
  it("rejects over-depth feed HTML before Turndown constructs a DOM", () => {
    const turndown = vi.spyOn(TurndownService.prototype, "turndown");
    const content = `${"<div>".repeat(41)}evidence${"</div>".repeat(41)}`;

    try {
      expect(() =>
        createRepresentations({
          baseUri: "https://example.test/feed/item",
          content,
          maxDepth: 40,
          maxNodes: 10_000,
          maxOutputBytes: 64 * 1024,
          mediaType: "text/html",
          outputBudgetErrorCode: ERROR_CODE,
          producerKey: "generic",
          title: "Bounded feed entry",
        }),
      ).toThrowError(ERROR_CODE);
      expect(turndown).not.toHaveBeenCalled();
    } finally {
      turndown.mockRestore();
    }
  });

  it.each([
    "<h1></table>".repeat(60),
    "<h1>".repeat(60),
    "<tr><li>".repeat(60),
    "<tfoot><tbody>".repeat(60),
    "<colgroup>".repeat(60),
    `${"<div>".repeat(39)}<td><th>`,
  ])("rejects parser-repaired malformed HTML before Turndown", (content) => {
    const turndown = vi.spyOn(TurndownService.prototype, "turndown");

    try {
      expect(() =>
        createRepresentations({
          baseUri: "https://example.test/feed/item",
          content,
          maxDepth: 40,
          maxNodes: 10_000,
          maxOutputBytes: 64 * 1024,
          mediaType: "text/html",
          outputBudgetErrorCode: ERROR_CODE,
          producerKey: "generic",
          title: "Bounded feed entry",
        }),
      ).toThrowError(ERROR_CODE);
      expect(turndown).not.toHaveBeenCalled();
    } finally {
      turndown.mockRestore();
    }
  });

  it("rejects an over-depth RSS HTML candidate before Turndown and falls back", () => {
    const turndown = vi.spyOn(TurndownService.prototype, "turndown");
    const nested = `${"<div>".repeat(41)}evidence${"</div>".repeat(41)}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
        <title>Bounded feed</title>
        <link>https://example.test/</link>
        <description>Research updates</description>
        <item>
          <title>Over-depth entry</title>
          <link>https://example.test/feed/item</link>
          <description><![CDATA[${nested}]]></description>
        </item>
      </channel></rss>`;
    const bytes = new TextEncoder().encode(xml);

    try {
      const result = normalizeFeedCapture({
        budget: {
          maxBytes: 1024 * 1024,
          maxDepth: 40,
          maxEntries: 100,
          maxEntryOutputBytes: 512 * 1024,
          maxNodes: 10_000,
          maxTotalOutputBytes: 4 * 1024 * 1024,
        },
        capture: {
          baseLocator: "https://example.test/feed.xml",
          bytes,
          contentIdentity:
            `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
          mediaType: "application/rss+xml",
        },
      });

      expect(result.ok).toBe(true);
      expect(turndown).not.toHaveBeenCalled();
    } finally {
      turndown.mockRestore();
    }
  });
});
