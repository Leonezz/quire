import { describe, expect, it } from "vitest";
import { applyArtifactEdit, artifactContent, artifactInfoOf, textOfMarkup } from "./artifacts";

describe("artifacts", () => {
  it("reads the words of markup without scripts, styles, comments or entities", () => {
    expect(textOfMarkup("<style>p{}</style><h1>Mean &amp; variance</h1><!-- note --><p>x&#x2264;y&nbsp;z</p><script>alert(1)</script>")).toBe("Mean & variance x≤y z");
  });

  it("keeps a code artifact's backticks inside its fence", () => {
    const content = artifactContent({ type: "code", source: "s = '```'", language: "python", title: "x", url: "quire://artifact/x" });
    expect(content.markdown).toBe("````python\ns = '```'\n````");
    expect(content.artifactSource).toBe("s = '```'");
  });

  it("edits exactly one occurrence", () => {
    expect(applyArtifactEdit("a b c", "b", "B")).toBe("a B c");
    expect(() => applyArtifactEdit("a a", "a", "b")).toThrow(/more than once/);
    expect(() => applyArtifactEdit("a", "z", "b")).toThrow(/does not occur/);
  });

  it("treats an artifact written before types as Markdown, version 1", () => {
    expect(artifactInfoOf({ origin: "agent", fetchedAt: "2026-01-01T00:00:00.000Z" })).toEqual({ type: "markdown", version: 1, updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(artifactInfoOf({ origin: "web", fetchedAt: "2026-01-01T00:00:00.000Z" })).toBeUndefined();
  });
});
