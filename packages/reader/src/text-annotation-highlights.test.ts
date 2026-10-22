import { describe, expect, it, vi } from "vitest";
import type { TextAnnotation as AnnotationView } from "./types";
import { installTextAnnotationHighlights, textAnnotationHighlightStyles } from "./text-annotation-highlights";
import { encodeTextQuoteV2Locator } from "./text-quote-selection";

function textAnnotation(
  id: string,
  quote: string,
  occurrence: number,
  overrides: Partial<AnnotationView> = {},
): AnnotationView {
  return {
    id,
    color: "#ffd400",
    interpretationKey: "rw.interpretation.text.v1",
    kind: "highlight",
    locator: encodeTextQuoteV2Locator({
      occurrence,
      prefix: "",
      suffix: "",
    }),
    note: "",
    quote,
    ...overrides,
  };
}

describe("text annotation highlights", () => {
  it("groups current exact-quote ranges without changing reader markup", () => {
    const root = document.createElement("article");
    root.innerHTML =
      "<p>First <strong>target phrase</strong>.</p><p>Second target phrase.</p>";
    const markup = root.innerHTML;
    const set = vi.fn();
    const remove = vi.fn();
    const makeHighlight = vi.fn((...ranges: Range[]) => ({ ranges }));

    const layer = installTextAnnotationHighlights({
      annotations: [
        textAnnotation("yellow", "target phrase", 0),
        textAnnotation("blue", "target phrase", 1, {
          color: "#2ea8e5",
          kind: "underline",
        }),
      ],
      environment: { makeHighlight, registry: { delete: remove, set } },
      namePrefix: "reader-one",
      root,
    });

    expect(layer).toMatchObject({ resolved: 2, unresolved: 0 });
    expect(makeHighlight).toHaveBeenCalledTimes(2);
    expect(makeHighlight.mock.calls[0]?.[0]?.toString()).toBe("target phrase");
    expect(makeHighlight.mock.calls[1]?.[0]?.toString()).toBe("target phrase");
    expect(set.mock.calls.map(([name]) => name)).toEqual([
      "reader-one-highlight-yellow",
      "reader-one-underline-blue",
    ]);
    expect(root.innerHTML).toBe(markup);

    layer.dispose();
    expect(remove).toHaveBeenCalledWith("reader-one-highlight-yellow");
    expect(remove).toHaveBeenCalledWith("reader-one-underline-blue");
  });

  it("does not render non-text or unresolved annotations, and marks ones the host calls stale", () => {
    const root = document.createElement("article");
    root.textContent = "Only current exact text should be visible.";
    const set = vi.fn();
    const makeHighlight = vi.fn((...ranges: Range[]) => ({ ranges }));

    const layer = installTextAnnotationHighlights({
      annotations: [
        textAnnotation("stale", "current exact text", 0, { status: "stale" }),
        textAnnotation("area", "", 0, {
          kind: "area",
          locator: "pdf-region:v1:1:0:0:1:1",
        }),
        textAnnotation("missing", "missing passage", 0),
      ],
      environment: {
        makeHighlight,
        registry: { delete: vi.fn(), set },
      },
      namePrefix: "reader-two",
      root,
    });

    expect(layer).toMatchObject({ resolved: 1, unresolved: 1 });
    expect(set.mock.calls.map(([name]) => name)).toEqual(["reader-two-highlight-yellow-stale"]);
    expect(makeHighlight.mock.calls[0]?.[0]?.toString()).toBe("current exact text");
    expect([...layer.placements.keys()]).toEqual(["stale", "missing"]);
    expect(layer.placements.get("stale")?.status).toBe("stale");
    expect(layer.placements.get("missing")).toEqual({ status: "unplaced" });
  });

  it("draws a highlight whose sentence had a word changed as stale, in its own layer", () => {
    const root = document.createElement("article");
    root.innerHTML =
      "<p>Intro.</p><p>The cache keeps every response for a day before it asks again.</p><p>Outro.</p>";
    const set = vi.fn();
    const makeHighlight = vi.fn((...ranges: Range[]) => ({ ranges }));

    const layer = installTextAnnotationHighlights({
      annotations: [
        textAnnotation("edited", "The cache keeps every response for an hour before it asks again.", 0, {
          locator: encodeTextQuoteV2Locator({ occurrence: 0, prefix: "Intro.", suffix: "Outro." }),
        }),
        textAnnotation("exact", "Outro.", 0),
      ],
      environment: { makeHighlight, registry: { delete: vi.fn(), set } },
      namePrefix: "reader-edit",
      root,
    });

    expect(layer).toMatchObject({ resolved: 2, unresolved: 0 });
    expect(set.mock.calls.map(([name]) => name)).toEqual([
      "reader-edit-highlight-yellow-stale",
      "reader-edit-highlight-yellow",
    ]);
    const stale = layer.placements.get("edited");
    expect(stale?.status).toBe("stale");
    expect(stale && "range" in stale ? stale.range.toString() : undefined).toBe(
      "The cache keeps every response for a day before it asks again.",
    );
    expect(layer.placements.get("exact")?.status).toBe("current");
  });

  it("lists a highlight whose text was removed as unplaced, without drawing it", () => {
    const root = document.createElement("article");
    root.innerHTML = "<p>Intro.</p><p>Outro.</p>";
    const set = vi.fn();

    const layer = installTextAnnotationHighlights({
      annotations: [
        textAnnotation("removed", "The cache keeps every response for an hour before it asks again.", 0, {
          locator: encodeTextQuoteV2Locator({ occurrence: 0, prefix: "Intro.", suffix: "Outro." }),
        }),
      ],
      environment: { makeHighlight: vi.fn(), registry: { delete: vi.fn(), set } },
      namePrefix: "reader-removed",
      root,
    });

    expect(layer).toMatchObject({ resolved: 0, unresolved: 1 });
    expect(layer.placements.get("removed")).toEqual({ status: "unplaced" });
    expect(set).not.toHaveBeenCalled();
  });

  it("still reports placements where the Highlight API is missing", () => {
    const root = document.createElement("article");
    root.innerHTML = "<p>Only this text.</p>";

    const layer = installTextAnnotationHighlights({
      annotations: [textAnnotation("here", "this text", 0), textAnnotation("gone", "a passage that went away", 0)],
      namePrefix: "reader-bare",
      root,
    });

    expect(layer).toMatchObject({ resolved: 1, unresolved: 1 });
    expect(layer.placements.get("here")?.status).toBe("current");
    expect(layer.placements.get("gone")).toEqual({ status: "unplaced" });
    expect(() => layer.dispose()).not.toThrow();
  });

  it("styles stale layers with a fainter wash and a dashed underline", () => {
    const styles = textAnnotationHighlightStyles("reader-css");
    expect(styles).toContain("::highlight(reader-css-highlight-yellow) { background-color: rgb(255 212 0 / 0.28); }");
    expect(styles).toMatch(/::highlight\(reader-css-highlight-yellow-stale\) \{[^}]*dashed[^}]*var\(--label-3\)/);
    expect(styles).toMatch(/::highlight\(reader-css-underline-blue-stale\) \{[^}]*underline dashed/);
  });

  it("installs an independent focus layer for an exact note-to-source reveal", () => {
    const root = document.createElement("article");
    root.innerHTML =
      "<section><h2>Section 3</h2><p>The protocol uses conditional requests for cache validation.</p></section>";
    const set = vi.fn();
    const remove = vi.fn();
    const makeHighlight = vi.fn((...ranges: Range[]) => ({ ranges }));

    const layer = installTextAnnotationHighlights({
      annotations: [],
      emphasis: {
        locator: encodeTextQuoteV2Locator({
          occurrence: 0,
          prefix: "protocoluses",
          suffix: "forcache",
        }),
        quote: "conditional requests",
      },
      environment: { makeHighlight, registry: { delete: remove, set } },
      namePrefix: "reader-rfc",
      root,
    });

    expect(layer).toMatchObject({
      emphasisResolved: true,
      resolved: 0,
      unresolved: 0,
    });
    expect(makeHighlight).toHaveBeenCalledOnce();
    expect(makeHighlight.mock.calls[0]?.[0]?.toString()).toBe(
      "conditional requests",
    );
    expect(set).toHaveBeenCalledWith(
      "reader-rfc-focus",
      expect.anything(),
    );

    layer.dispose();
    expect(remove).toHaveBeenCalledWith("reader-rfc-focus");
  });

  it("activates a saved annotation from an ordinary click without intercepting text selection", () => {
    const root = document.createElement("article");
    root.innerHTML = "<p>First <strong>target phrase</strong>.</p>";
    document.body.append(root);
    const targetText = root.querySelector("strong")!.firstChild!;
    const caret = document.createRange();
    caret.setStart(targetText, 4);
    caret.collapse(true);
    const caretRangeDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "caretRangeFromPoint",
    );
    Object.defineProperty(document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret),
    });
    const onActivate = vi.fn();

    try {
      const layer = installTextAnnotationHighlights({
        annotations: [textAnnotation("annotation-clicked", "target phrase", 0)],
        environment: {
          makeHighlight: (...ranges: Range[]) => ({ ranges }),
          registry: { delete: vi.fn(), set: vi.fn() },
        },
        namePrefix: "reader-click",
        onActivate,
        root,
      });

      root.querySelector("strong")!.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          clientX: 40,
          clientY: 20,
        }),
      );
      expect(onActivate).toHaveBeenCalledWith("annotation-clicked");

      const selection = window.getSelection()!;
      const selected = document.createRange();
      selected.selectNodeContents(targetText);
      selection.removeAllRanges();
      selection.addRange(selected);
      root.querySelector("strong")!.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          clientX: 40,
          clientY: 20,
        }),
      );
      expect(onActivate).toHaveBeenCalledTimes(1);

      selection.removeAllRanges();
      layer.dispose();
      root.querySelector("strong")!.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          clientX: 40,
          clientY: 20,
        }),
      );
      expect(onActivate).toHaveBeenCalledTimes(1);
    } finally {
      root.remove();
      if (caretRangeDescriptor) {
        Object.defineProperty(document, "caretRangeFromPoint", caretRangeDescriptor);
      } else {
        Reflect.deleteProperty(document, "caretRangeFromPoint");
      }
    }
  });
});
