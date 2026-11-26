import { parseHTML } from "linkedom";

// Dedicated Web Workers have no `document` or `window`, while browser builds of
// `decode-named-character-reference` (micromark/remark) and `turndown` access `document`
// at module initialization time. Install a lightweight LinkeDOM document before any
// normalizer dependencies evaluate.
if (typeof globalThis.document === "undefined") {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, {
    document: dom.document,
    DOMParser: dom.DOMParser,
    Node: dom.Node,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    DocumentFragment: dom.DocumentFragment,
    ...(typeof globalThis.window === "undefined" ? { window: dom.window } : {}),
  });
}
