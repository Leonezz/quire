// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMarkdown, isVerifiedCitation, parseBlocks } from "./AgentMarkdown";

const REAL = "526130b61f003c33";
const FAKE = "deadbeefdeadbeef";
const handlers = () => ({ onOpenLink: vi.fn(), onOpenMaterial: vi.fn(), titleOf: (id: string) => (id === REAL ? "CSS Custom Highlight API" : undefined) });

afterEach(cleanup);

describe("parseBlocks", () => {
  it("splits headings, fences, lists, quotes and paragraphs", () => {
    const blocks = parseBlocks("## Title\n\nA line\nsame paragraph\n\n```js\nconst x = 1;\n```\n\n- one\n- two\n\n1. first\n2) second\n\n> quoted\n> more");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "code", "list", "list", "quote"]);
    expect(blocks[1]).toEqual({ kind: "paragraph", text: "A line same paragraph" });
    expect(blocks[2]).toEqual({ kind: "code", lang: "js", code: "const x = 1;" });
    expect(blocks[3]).toEqual({ kind: "list", ordered: false, items: ["one", "two"] });
    expect(blocks[4]).toEqual({ kind: "list", ordered: true, items: ["first", "second"] });
    expect(blocks[5]).toEqual({ kind: "quote", text: "quoted more" });
  });
  it("keeps an unterminated fence as code while streaming", () => {
    expect(parseBlocks("```\nstill typ")).toEqual([{ kind: "code", lang: "", code: "still typ" }]);
  });
});

describe("AgentMarkdown", () => {
  it("renders headings, code, lists and links through the handlers", () => {
    const h = handlers();
    render(<AgentMarkdown text={"# Heading\n\nSee [the spec](https://example.org/spec) and `code`.\n\n```ts\nlet a;\n```\n\n- item"} {...h} />);
    expect(screen.getByRole("heading", { level: 4 }).textContent).toBe("Heading");
    expect(document.querySelector("pre code")?.textContent).toBe("let a;");
    expect(screen.getByRole("listitem").textContent).toBe("item");
    expect(document.querySelector("code:not(pre code)")?.textContent).toBe("code");
    fireEvent.click(screen.getByRole("link", { name: "the spec" }));
    expect(h.onOpenLink).toHaveBeenCalledWith("https://example.org/spec");
  });

  it("marks a citation verified only when the turn's sources name it", () => {
    const h = handlers();
    render(<AgentMarkdown text={`Real [${REAL}] and fake [${FAKE}].`} {...h} sources={[REAL]} />);
    const real = screen.getByRole("button", { name: "Open CSS Custom Highlight API" });
    const fake = screen.getByRole("button", { name: `Open material ${FAKE} (unverified citation)` });
    expect(real.getAttribute("data-unverified")).toBeNull();
    expect(fake.getAttribute("data-unverified")).toBe("true");
    fireEvent.click(real);
    expect(h.onOpenMaterial).toHaveBeenCalledWith(REAL);
  });

  it("treats a library id in the sources list as unverified when the sources say otherwise", () => {
    expect(isVerifiedCitation(REAL, { sources: [], titleOf: handlers().titleOf })).toBe(false);
    expect(isVerifiedCitation(REAL, { sources: [REAL], titleOf: () => undefined })).toBe(true);
  });

  it("turns a backticked id and a bare library id into titled pills, and leaves other hex alone", () => {
    const h = handlers();
    render(<AgentMarkdown text={`Code \`${REAL}\`, bare ${REAL}, and a hash ${FAKE} nobody knows; \`${FAKE}\` in code is still a citation.`} {...h} sources={[REAL]} />);
    const real = screen.getAllByRole("button", { name: "Open CSS Custom Highlight API" });
    expect(real).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: `Open material ${FAKE} (unverified citation)` })).toHaveLength(1);
    expect(screen.getByText(/and a hash deadbeefdeadbeef nobody knows/)).toBeTruthy();
    expect(document.querySelector("code:not(pre code)")).toBeNull();
    fireEvent.click(real[1]!);
    expect(h.onOpenMaterial).toHaveBeenCalledWith(REAL);
  });

  it("does not read a bare id out of a longer word, url or hash", () => {
    const h = handlers();
    render(<AgentMarkdown text={`See https://x.org/${REAL}/v and ${REAL}abc and #${REAL} and v1.${REAL} and ${REAL}.md.`} {...h} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads a bare id that ends a sentence or stands in parentheses", () => {
    const h = handlers();
    render(<AgentMarkdown text={`It is ${REAL}. Also (${REAL}), and ${REAL}: done.`} {...h} />);
    expect(screen.getAllByRole("button", { name: "Open CSS Custom Highlight API" })).toHaveLength(3);
  });

  it("carries the quoted passage that ends right before the pill", () => {
    const h = handlers();
    const quote = "styling arbitrary text ranges on a document";
    render(<AgentMarkdown text={`The page says “${quote}” [${REAL}]. Another line, "too short" [${REAL}], and a plain one [${REAL}].\n\n- “A **quoted** list item, stripped of markup” — ${REAL}`} {...h} />);
    const pills = screen.getAllByRole("button", { name: "Open CSS Custom Highlight API" });
    expect(pills.map((pill) => pill.getAttribute("data-quote"))).toEqual([quote, null, null, "A quoted list item, stripped of markup"]);
    fireEvent.click(pills[0]!);
    expect(h.onOpenMaterial).toHaveBeenLastCalledWith(REAL, quote);
    fireEvent.click(pills[2]!);
    expect(h.onOpenMaterial).toHaveBeenLastCalledWith(REAL);
  });

  it("falls back to library membership for a stored turn without sources", () => {
    const h = handlers();
    render(<AgentMarkdown text={`Real [${REAL}] and fake [${FAKE}].`} {...h} />);
    expect(screen.getByRole("button", { name: "Open CSS Custom Highlight API" }).getAttribute("data-unverified")).toBeNull();
    expect(screen.getByRole("button", { name: `Open material ${FAKE} (unverified citation)` }).getAttribute("data-unverified")).toBe("true");
  });
});
