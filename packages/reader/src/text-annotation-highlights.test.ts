import { describe, expect, it, vi } from "vitest";
import type { TextAnnotation as AnnotationView } from "./types";
import { installTextAnnotationHighlights } from "./text-annotation-highlights";
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

  it("does not render stale, non-text, or unresolved annotations", () => {
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

    expect(layer).toMatchObject({ resolved: 0, unresolved: 1 });
    expect(makeHighlight).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
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
