import { describe, expect, it } from "vitest";
import {
  decodeTextQuoteLocator,
  encodeTextQuoteV2Locator,
  renderedTextQuoteSelection,
  resolveTextQuoteRange,
  textInputSelectionCapture,
} from "./text-quote-selection";

describe("text quote selection", () => {
  it("encodes a renderer-independent v2 locator", () => {
    const locator = encodeTextQuoteV2Locator({
      occurrence: 1,
      prefix: "before",
      suffix: "after",
    });
    const payload = JSON.parse(
      Buffer.from(locator.slice("text-quote:v2:".length), "base64").toString(
        "utf8",
      ),
    );

    expect(payload).toEqual({
      occurrence: 1,
      prefix: "before",
      suffix: "after",
    });
  });

  it("captures selected input text for structured working copies", () => {
    const capture = textInputSelectionCapture("0.83", 0, 4, {
      after: "rerank0.91",
      before: "modelaccuracybaseline0.83rerank",
    });

    expect(capture).toEqual({
      locator: expect.stringMatching(/^text-quote:v2:/),
      quote: "0.83",
    });
    const payload = JSON.parse(
      Buffer.from(
        capture!.locator.slice("text-quote:v2:".length),
        "base64",
      ).toString("utf8"),
    );
    expect(payload).toMatchObject({
      occurrence: 1,
      position: expect.any(Number),
      prefix: expect.stringMatching(/baseline0\.83rerank$/),
      suffix: expect.stringMatching(/^rerank0\.91/),
    });
    expect(payload.position).toBe("modelaccuracybaseline0.83rerank".length);
  });

  it("rejects empty and invalid selections", () => {
    expect(textInputSelectionCapture("value", 2, 2)).toBeUndefined();
    expect(textInputSelectionCapture("value", null, null)).toBeUndefined();
    expect(textInputSelectionCapture("value", 0, 99)).toBeUndefined();
  });

  it("disambiguates repeated values with a global occurrence and context", () => {
    const first = textInputSelectionCapture("0.83", 0, 4, {
      before: "modelaccuracybaseline",
      after: "rerank0.83",
    });
    const second = textInputSelectionCapture("0.83", 0, 4, {
      before: "modelaccuracybaseline0.83rerank",
      after: "",
    });
    const payload = (locator: string) =>
      JSON.parse(
        Buffer.from(locator.slice("text-quote:v2:".length), "base64").toString(
          "utf8",
        ),
      ) as { occurrence: number; prefix: string; suffix: string };

    expect(first?.locator).not.toBe(second?.locator);
    expect(payload(first!.locator)).toMatchObject({ occurrence: 0 });
    expect(payload(second!.locator)).toMatchObject({ occurrence: 1 });
  });

  it("decodes both persisted locator versions and rejects malformed payloads", () => {
    const locator = encodeTextQuoteV2Locator({ occurrence: 2, prefix: "a", suffix: "b" });
    expect(decodeTextQuoteLocator(locator)).toEqual({ occurrence: 2, prefix: "a", suffix: "b" });
    expect(decodeTextQuoteLocator(locator.replace("v2", "v1"))).toEqual({ occurrence: 2, prefix: "a", suffix: "b" });
    expect(decodeTextQuoteLocator("text-quote:v2:not-base64")).toBeUndefined();
  });

  it("normalizes section context before persisting it", () => {
    const locator = encodeTextQuoteV2Locator({
      occurrence: 0,
      prefix: "before",
      section: "  Methods\n  Evaluation  ",
      suffix: "after",
    });

    expect(decodeTextQuoteLocator(locator)).toMatchObject({
      section: "Methods Evaluation",
    });
  });

  it("resolves a repeated quote across inline reader nodes", () => {
    const root = document.createElement("article");
    root.innerHTML = "<p>Earlier target phrase.</p><p>Before <strong>target</strong> phrase after.</p>";
    const locator = encodeTextQuoteV2Locator({
      occurrence: 1,
      prefix: "Before",
      suffix: "after.",
    });
    const range = resolveTextQuoteRange(root, locator, "target phrase");
    expect(range?.toString()).toBe("target phrase");
    expect(range?.startContainer.parentElement?.tagName).toBe("STRONG");
  });

  it("captures the rendered quote without reader footnote controls", () => {
    const root = document.createElement("article");
    root.innerHTML =
      '<p>Earlier target phrase.</p><p>Before <strong>target</strong> phrase<a data-footnote-ref>2</a> after.</p>';
    document.body.append(root);
    const paragraph = root.querySelectorAll("p")[1]!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = renderedTextQuoteSelection(root, selection);

    expect(result).toMatchObject({
      kind: "capture",
      capture: {
        locator: expect.stringMatching(/^text-quote:v2:/),
        quote: "Before target phrase after.",
      },
    });
    if (result.kind === "capture") {
      const resolved = resolveTextQuoteRange(root, result.capture.locator, result.capture.quote);
      expect(resolved).toBeDefined();
      expect(resolved?.startContainer.parentElement?.closest("[data-footnote-ref]"))
        .toBeNull();
      expect(resolved?.endContainer.parentElement?.closest("[data-footnote-ref]"))
        .toBeNull();
    }
    root.remove();
    selection?.removeAllRanges();
  });

  it("captures the hierarchical section path around rendered text", () => {
    const root = document.createElement("article");
    root.innerHTML = [
      "<h2>Methods</h2>",
      "<p>Setup details.</p>",
      "<h3>Evaluation</h3>",
      '<p id="target">Selected evidence appears here.</p>',
      "<h3>Limitations</h3>",
    ].join("");
    document.body.append(root);
    const target = root.querySelector("#target")!;
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = renderedTextQuoteSelection(root, selection);

    expect(result).toMatchObject({ kind: "capture" });
    if (result.kind === "capture") {
      expect(decodeTextQuoteLocator(result.capture.locator)).toMatchObject({
        position: expect.any(Number),
        section: "Methods › Evaluation",
      });
    }
    root.remove();
    selection?.removeAllRanges();
  });

  it("rejects a selection made entirely inside a footnote control", () => {
    const root = document.createElement("article");
    root.innerHTML = '<p>Claim<a data-footnote-ref>2</a></p>';
    document.body.append(root);
    const control = root.querySelector("[data-footnote-ref]")!;
    const range = document.createRange();
    range.selectNodeContents(control);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(renderedTextQuoteSelection(root, selection)).toEqual({
      kind: "blocked",
      reason: "Select source text rather than a footnote control.",
    });
    root.remove();
    selection?.removeAllRanges();
  });

  it("does not resolve a locator whose exact quote is absent", () => {
    const root = document.createElement("article");
    root.textContent = "Different rendered text";
    expect(resolveTextQuoteRange(
      root,
      encodeTextQuoteV2Locator({ occurrence: 0, prefix: "", suffix: "" }),
      "missing quote",
    )).toBeUndefined();
  });
});
