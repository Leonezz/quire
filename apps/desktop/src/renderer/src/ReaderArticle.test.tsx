// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";

vi.mock("./api", () => ({ read: {}, isPreview: false }));

import { ReaderArticle } from "./ReaderArticle";
import { DEFAULT_PREFS } from "./readingPrefs";

afterEach(() => { cleanup(); });

const KEY = "c".repeat(64);
const image = (url: string) => ({ type: "image", url, alt: url, title: null });
const payload = { type: "root", losses: [], children: [{ type: "paragraph", children: [image("https://example.org/chart.png"), image("quire-figure://0123456789abcdef/1.png"), image("https://example.org/hotlink.png")] }] };
const material = { id: "0123456789abcdef", title: "Charts", finalUrl: "https://example.org/a", url: "https://example.org/a", origin: "web", meta: { kind: "webpage", title: "Charts" } } as unknown as MaterialRecord;
const content = { view: "web", mediaType: "text/html", reader: { schema: "reader.document.v2", payload: JSON.stringify(payload) }, readingMinutes: 1, quality: undefined, problems: [] } as unknown as MaterialViewContent;

describe("ReaderArticle", () => {
  it("shows the images main serves on quire-image, and never a remote URL a resolver hands back", async () => {
    const answers: Record<string, string> = {
      "https://example.org/chart.png": `quire-image://cache/${KEY}`,
      "quire-figure://0123456789abcdef/1.png": "quire-image://figure/0123456789abcdef/1.png",
      "https://example.org/hotlink.png": "https://example.org/hotlink.png",
    };
    const resolveImage = vi.fn(async (url: string) => answers[url]);
    const { container } = render(<ReaderArticle material={material} content={content} prefs={DEFAULT_PREFS} resolveImage={resolveImage} onOpenLink={() => undefined} />);
    await waitFor(() => expect(container.querySelectorAll('img[data-reader-image="resolved"]')).toHaveLength(2));
    expect(Array.from(container.querySelectorAll('img[data-reader-image="resolved"]'), (img) => img.getAttribute("src"))).toEqual([`quire-image://cache/${KEY}`, "quire-image://figure/0123456789abcdef/1.png"]);
    expect(container.querySelectorAll('[data-reader-image="unresolved"]')).toHaveLength(1);
  });
});
