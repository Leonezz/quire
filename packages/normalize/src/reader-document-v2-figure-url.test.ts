import { describe, expect, it } from "vitest";

import { readerDocumentV2Schema } from "./reader-document-v2-contract";

const documentWithImage = (url: string) => ({
  type: "root",
  losses: [],
  children: [{ type: "paragraph", children: [{ type: "image", url, alt: "Figure 1", title: null }] }],
});

const documentWithLink = (url: string) => ({
  type: "root",
  losses: [],
  children: [{ type: "paragraph", children: [{ type: "link", url, title: null, children: [{ type: "text", value: "x" }] }] }],
});

describe("reader document v2 image URLs", () => {
  it("accepts the desktop app's figure crops of a PDF text view", () => {
    expect(readerDocumentV2Schema.safeParse(documentWithImage("quire-figure://8667175ac66aac06/1.png")).success).toBe(true);
    expect(readerDocumentV2Schema.safeParse(documentWithImage("https://example.test/figure.png")).success).toBe(true);
  });

  it("still refuses other protocols for images and the figure protocol for links", () => {
    expect(readerDocumentV2Schema.safeParse(documentWithImage("file:///etc/hosts")).success).toBe(false);
    expect(readerDocumentV2Schema.safeParse(documentWithImage("javascript:alert(1)")).success).toBe(false);
    expect(readerDocumentV2Schema.safeParse(documentWithLink("quire-figure://8667175ac66aac06/1.png")).success).toBe(false);
  });
});
