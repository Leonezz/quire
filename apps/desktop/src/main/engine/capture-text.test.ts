import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureTextOf } from "./capture-text";

describe("captureTextOf", () => {
  it("keeps block structure, headings, lists, quotes, code, links and images; drops scripts, styles, svg, iframes and templates", async () => {
    const html = await readFile(join(__dirname, "__fixtures__", "capture.html"), "utf8");
    const text = captureTextOf(html);
    expect(text).toBe([
      "Home Archive",
      "",
      "# Cache keys that include the prompt",
      "",
      "By [Ada Lovelace](https://systems.example.test/about) · 1 September 2026",
      "",
      "Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one.",
      "The fix is small.",
      "",
      "## What went wrong",
      "",
      "- The key ignored the system prompt.",
      "- Nobody noticed for a week.",
      "",
      "> Caches are a promise about identity.",
      "",
      "```",
      "def key(prompt):",
      "    return sha256(render(prompt))  # indented",
      "```",
      "",
      "![The cache path](https://systems.example.test/diagram.png)",
      "",
      "Figure 1: the path.",
      "",
      "See the [retries post](https://systems.example.test/posts/retries) and this one.",
      "",
      "Harness | Hit rate |",
      "",
      "A | 90% |",
      "",
      "### Related",
      "",
      "[Other post](https://systems.example.test/posts/other)",
      "",
      "© Systems Notes",
    ].join("\n"));
    expect(text).not.toMatch(/dataLayer|font: 16px|hidden svg text|Enable JavaScript|never rendered|ads\.example/);
  });

  it("renders fragments without a body and empty documents", () => {
    expect(captureTextOf("<p>One</p><p>Two</p>")).toBe("One\n\nTwo");
    expect(captureTextOf("")).toBe("");
  });
});
