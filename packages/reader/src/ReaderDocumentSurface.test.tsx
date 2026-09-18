import { readerImageLimits } from "./ReaderDocumentSurface";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReaderDocumentSurface } from "./index";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderSurface(
  props: React.ComponentProps<typeof ReaderDocumentSurface>,
) {
  document.body.innerHTML = renderToStaticMarkup(
    <ReaderDocumentSurface {...props} />,
  );
  return document.body;
}

describe("ReaderDocumentSurface", () => {
  it("renders canonical document anchors with surface-local DOM identifiers", () => {
    const props: React.ComponentProps<typeof ReaderDocumentSurface> = {
      fallback: { content: "Fallback", format: "plain" },
      payload: {
        type: "root",
        losses: [],
        children: [
          {
            anchor: "section-7.1",
            type: "section",
            children: [
              {
                anchor: "section-7.1-1",
                type: "heading",
                depth: 2,
                children: [{ type: "text", value: "Field Lines" }],
              },
              {
                type: "paragraph",
                children: [
                  {
                    type: "link",
                    url: "https://www.rfc-editor.org/rfc/rfc9110.html#section-7.1-1",
                    targetAnchor: "section-7.1-1",
                    title: null,
                    children: [{ type: "text", value: "the definition" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      schema: "reader.document.v2",
    };

    document.body.innerHTML = renderToStaticMarkup(
      <>
        <ReaderDocumentSurface {...props} />
        <ReaderDocumentSurface {...props} />
      </>,
    );

    const sections = document.body.querySelectorAll(
      '[data-reader-anchor="section-7.1"]',
    );
    const headings = document.body.querySelectorAll(
      '[data-reader-anchor="section-7.1-1"]',
    );
    expect(sections).toHaveLength(2);
    expect(headings).toHaveLength(2);
    expect(sections[0]?.id).not.toBe(sections[1]?.id);
    expect(headings[0]?.id).not.toBe(headings[1]?.id);
    const links = document.body.querySelectorAll(
      '[data-reader-link-anchor="section-7.1-1"]',
    );
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe(`#${headings[0]?.id}`);
    expect(links[1]?.getAttribute("href")).toBe(`#${headings[1]?.id}`);
    expect(links[0]?.getAttribute("target")).toBeNull();
  });

  it("renders the strict v2 reader contract as semantic article elements", () => {
    const surface = renderSurface({
      fallback: { content: "This fallback must not render", format: "plain" },
      payload: {
        type: "root",
        losses: [],
        children: [
          {
            type: "section",
            children: [
              {
                type: "heading",
                depth: 2,
                children: [{ type: "text", value: "Method" }],
              },
              {
                type: "paragraph",
                children: [
                  {
                    type: "insert",
                    children: [{ type: "text", value: "added" }],
                  },
                  { type: "text", value: " " },
                  {
                    type: "mark",
                    children: [{ type: "text", value: "highlighted" }],
                  },
                  { type: "text", value: " H" },
                  {
                    type: "subscript",
                    children: [{ type: "text", value: "2" }],
                  },
                  { type: "text", value: "O x" },
                  {
                    type: "superscript",
                    children: [{ type: "text", value: "2" }],
                  },
                  { type: "text", value: " " },
                  {
                    type: "keyboard",
                    children: [{ type: "text", value: "⌘K" }],
                  },
                  { type: "text", value: " " },
                  {
                    type: "abbreviation",
                    title: "Application programming interface",
                    children: [{ type: "text", value: "API" }],
                  },
                  { type: "text", value: " " },
                  {
                    type: "cite",
                    children: [{ type: "text", value: "Knuth 1984" }],
                  },
                  { type: "text", value: " said " },
                  {
                    type: "quote",
                    children: [{ type: "text", value: "measure" }],
                  },
                  { type: "text", value: " for " },
                  {
                    type: "math",
                    display: false,
                    format: "tex",
                    label: null,
                    value: "E = mc^2",
                  },
                  { type: "text", value: "." },
                  {
                    type: "footnoteReference",
                    identifier: "note-1",
                    label: "1",
                  },
                  { type: "text", value: " Repeated evidence" },
                  {
                    type: "footnoteReference",
                    identifier: "note-1",
                    label: "1",
                  },
                ],
              },
            ],
          },
          {
            type: "figure",
            media: [
              {
                type: "image",
                url: "https://media.example.test/result.png",
                alt: "Benchmark result",
                title: null,
              },
            ],
            caption: [{ type: "text", value: "Figure 1. Benchmark result." }],
            credit: [{ type: "text", value: "Source: authors." }],
          },
          {
            type: "code",
            lang: "typescript",
            meta: null,
            value: "const result = 1;",
          },
          {
            type: "math",
            display: true,
            format: "tex",
            label: "Equation 1",
            value: "\\\\int_0^1 x^2 dx",
          },
          {
            type: "table",
            caption: [{ type: "text", value: "Table 1. Evaluation" }],
            head: {
              type: "tableSection",
              children: [
                {
                  type: "tableRow",
                  children: [
                    {
                      type: "tableCell",
                      align: "left",
                      colSpan: 1,
                      rowSpan: 1,
                      header: true,
                      scope: "col",
                      children: [
                        {
                          type: "paragraph",
                          children: [{ type: "text", value: "Metric" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            bodies: [
              {
                type: "tableSection",
                children: [
                  {
                    type: "tableRow",
                    children: [
                      {
                        type: "tableCell",
                        align: "left",
                        colSpan: 1,
                        rowSpan: 1,
                        header: false,
                        scope: null,
                        children: [
                          {
                            type: "paragraph",
                            children: [{ type: "text", value: "Accuracy" }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
            foot: null,
          },
          {
            type: "footnoteDefinition",
            identifier: "note-1",
            label: "1",
            children: [
              {
                type: "paragraph",
                children: [{ type: "text", value: "Supporting evidence." }],
              },
            ],
          },
        ],
      },
      schema: "reader.document.v2",
    });

    expect(
      surface.querySelector('[data-reader-schema="reader.document.v2"]'),
    ).not.toBeNull();
    expect(
      surface.querySelector("section[data-reader-section] h2")?.textContent,
    ).toBe("Method");
    expect(surface.querySelector("ins")?.textContent).toBe("added");
    expect(surface.querySelector("mark")?.textContent).toBe("highlighted");
    expect(surface.querySelector("sub")?.textContent).toBe("2");
    expect(surface.querySelector("sup")?.textContent).toBe("2");
    expect(surface.querySelector("kbd")?.textContent).toBe("⌘K");
    expect(surface.querySelector("abbr")?.getAttribute("title")).toBe(
      "Application programming interface",
    );
    expect(surface.querySelector("cite")?.textContent).toBe("Knuth 1984");
    expect(surface.querySelector("q")?.textContent).toBe("measure");
    expect(
      surface.querySelector('figure [data-reader-image="unresolved"]')
        ?.textContent,
    ).toBe("Benchmark result");
    expect(surface.querySelector("figcaption")?.textContent).toContain(
      "Figure 1. Benchmark result.",
    );
    expect(surface.querySelector("figcaption")?.textContent).toContain(
      "Source: authors.",
    );
    expect(
      surface.querySelector('pre[data-reader-code="raw"] code')?.textContent,
    ).toBe("const result = 1;");
    expect(
      surface.querySelector('[data-reader-math="inline"]')?.textContent,
    ).toContain("E = mc^2");
    expect(
      surface.querySelector('[data-reader-math="display"]')?.textContent,
    ).toContain("\\int_0^1 x^2 dx");
    expect(surface.querySelector("table caption")?.textContent).toBe(
      "Table 1. Evaluation",
    );
    expect(
      surface
        .querySelector('[role="region"].reader-document-table')
        ?.getAttribute("aria-label"),
    ).toBe("Scrollable table: Table 1. Evaluation");
    expect(surface.querySelector("thead th")?.getAttribute("scope")).toBe(
      "col",
    );
    expect(surface.querySelector("tbody td")?.textContent).toBe("Accuracy");
    const footnoteReferences = Array.from(
      surface.querySelectorAll<HTMLAnchorElement>(
        '[data-reader-footnote-ref="note-1"]',
      ),
    );
    expect(footnoteReferences).toHaveLength(2);
    expect(footnoteReferences[0]?.id).not.toBe(footnoteReferences[1]?.id);
    const footnoteDefinition = surface.querySelector<HTMLElement>(
      '[data-reader-footnote-definition="note-1"]',
    );
    expect(footnoteDefinition?.id).toBeTruthy();
    expect(footnoteReferences[0]?.getAttribute("href")).toBe(
      `#${footnoteDefinition?.id}`,
    );
    expect(footnoteDefinition?.textContent).toContain("Supporting evidence.");
    const footnoteBacklinks = Array.from(
      surface.querySelectorAll<HTMLAnchorElement>(
        '[data-reader-footnote-backref="note-1"]',
      ),
    );
    expect(footnoteBacklinks).toHaveLength(2);
    expect(footnoteBacklinks.map((link) => link.getAttribute("href"))).toEqual(
      footnoteReferences.map((reference) => `#${reference.id}`),
    );
    expect(surface.textContent).not.toContain("This fallback must not render");
  });

  it("keeps arbitrary footnote identifiers injective and namespaces anchors per reader surface", () => {
    const selectorSafeIdentifiers = ["?", "-3f-", "雪", "💡"];
    const identifiers = [...selectorSafeIdentifiers, "\ud800", "�"];
    const payload = {
      type: "root",
      losses: [],
      children: [
        {
          type: "paragraph",
          children: identifiers.map((identifier, index) => ({
            type: "footnoteReference",
            identifier,
            label: String(index + 1),
          })),
        },
        ...identifiers.map((identifier, index) => ({
          type: "footnoteDefinition",
          identifier,
          label: String(index + 1),
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", value: `Definition ${index + 1}` }],
            },
          ],
        })),
      ],
    };
    const props = {
      fallback: { content: "fallback", format: "plain" } as const,
      payload,
      schema: "reader.document.v2",
    };

    document.body.innerHTML = renderToStaticMarkup(
      <>
        <ReaderDocumentSurface {...props} />
        <ReaderDocumentSurface {...props} />
      </>,
    );

    const surfaces = Array.from(
      document.body.querySelectorAll<HTMLElement>(
        '[data-reader-schema="reader.document.v2"]',
      ),
    );
    expect(surfaces).toHaveLength(2);
    const allIds = Array.from(
      document.body.querySelectorAll<HTMLElement>("[id]"),
    )
      .map((element) => element.id)
      .filter((id) => id.includes("footnote"));
    expect(new Set(allIds).size).toBe(allIds.length);

    for (const surface of surfaces) {
      for (const identifier of selectorSafeIdentifiers) {
        const reference = surface.querySelector<HTMLAnchorElement>(
          `[data-reader-footnote-ref="${identifier}"]`,
        );
        const definition = surface.querySelector<HTMLElement>(
          `[data-reader-footnote-definition="${identifier}"]`,
        );
        const backlink = surface.querySelector<HTMLAnchorElement>(
          `[data-reader-footnote-backref="${identifier}"]`,
        );
        expect(reference?.getAttribute("href")).toBe(`#${definition?.id}`);
        expect(backlink?.getAttribute("href")).toBe(`#${reference?.id}`);
      }
    }
  });

  it("loads host-resolved images asynchronously, caches safe results, and aborts on unmount", async () => {
    let resolveFirstResolution: (value: string | undefined) => void = () =>
      undefined;
    const firstResolution = new Promise<string | undefined>((resolve) => {
      resolveFirstResolution = resolve;
    });
    const resolveImageSource = vi.fn(
      (_sourceUrl: string, _signal: AbortSignal) => firstResolution,
    );
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    const props = {
      fallback: { content: "fallback", format: "plain" } as const,
      payload: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "image",
                url: "https://media.example.test/chart.png",
                alt: "Resolved chart",
                title: null,
              },
            ],
          },
        ],
      },
      resolveImageSource,
      schema: "reader.document.v1",
    };

    await act(async () => root.render(<ReaderDocumentSurface {...props} />));
    expect(
      container.querySelector('[data-reader-image="loading"]'),
    ).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();

    await act(async () => {
      resolveFirstResolution("data:image/png;base64,iVBORw0KGgo=");
      await firstResolution;
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );

    await act(async () => root.unmount());
    expect(resolveImageSource.mock.calls[0]?.[1].aborted).toBe(true);

    const cachedContainer = document.createElement("div");
    const cachedRoot = createRoot(cachedContainer);
    await act(async () =>
      cachedRoot.render(<ReaderDocumentSurface {...props} />),
    );
    expect(cachedContainer.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(resolveImageSource).toHaveBeenCalledTimes(1);
    await act(async () => cachedRoot.unmount());
  });

  it("automatically resolves remote article media without an approval action", async () => {
    const resolveImageSource = vi.fn(async () => undefined);
    const resolveRemoteImageSource = vi.fn(
      async () => "data:image/png;base64,iVBORw0KGgo=",
    );
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            children: [
              {
                type: "paragraph",
                children: [
                  {
                    type: "image",
                    url: "https://media.example.test/tracker.png",
                    alt: "Remote chart",
                    title: null,
                  },
                ],
              },
            ],
          }}
          resolveImageSource={resolveImageSource}
          resolveRemoteImageSource={resolveRemoteImageSource}
          schema="reader.document.v1"
        />,
      );
      await Promise.resolve();
    });

    expect(resolveImageSource).not.toHaveBeenCalled();
    expect(resolveRemoteImageSource).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('img[data-reader-image="resolved"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[data-reader-load-remote-image=""]'),
    ).toBeNull();
    await act(async () => root.unmount());
  });

  it("names table regions while external media is being resolved", () => {
    const surface = renderSurface({
      fallback: { content: "fallback", format: "plain" },
      payload: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "image",
                url: "https://media.example.test/architecture.png",
                alt: "Architecture diagram",
                title: "Figure 2",
              },
              {
                type: "image",
                url: "https://media.example.test/latency.png",
                alt: "",
                title: "Latency plot",
              },
            ],
          },
          {
            type: "table",
            children: [
              {
                type: "tableRow",
                children: [
                  {
                    type: "tableCell",
                    children: [{ type: "text", value: "Topic" }],
                  },
                  {
                    type: "tableCell",
                    children: [{ type: "text", value: "Finding" }],
                  },
                ],
              },
            ],
          },
          {
            type: "table",
            children: [
              {
                type: "tableRow",
                children: [
                  {
                    type: "tableCell",
                    children: [{ type: "text", value: "Model" }],
                  },
                  {
                    type: "tableCell",
                    children: [{ type: "text", value: "Accuracy" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      resolveRemoteImageSource: async () => undefined,
      schema: "reader.document.v1",
    });

    expect(
      Array.from(
        surface.querySelectorAll<HTMLElement>(
          ".reader-document-table[role=region]",
        ),
        (region) => region.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Scrollable table: Topic / Finding",
      "Scrollable table: Model / Accuracy",
    ]);
  });

  it("keeps a failed remote image retry distinguishable by its alt and title", async () => {
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    const resolveRemoteImageSource = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            children: [
              {
                type: "paragraph",
                children: [
                  {
                    type: "image",
                    url: "https://media.example.test/retry.png",
                    alt: "Benchmark chart",
                    title: "Validation set",
                  },
                ],
              },
            ],
          }}
          resolveImageSource={async () => undefined}
          resolveRemoteImageSource={resolveRemoteImageSource}
          schema="reader.document.v1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const retryButton = container.querySelector<HTMLButtonElement>(
      'button[data-reader-load-remote-image=""]',
    );
    expect(resolveRemoteImageSource).toHaveBeenCalledTimes(1);
    expect(retryButton?.textContent).toBe("Retry remote image");
    expect(retryButton?.getAttribute("aria-label")).toBe(
      "Retry remote image: Benchmark chart — Validation set",
    );

    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolveRemoteImageSource).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("automatically resolves remote media again when the reader payload changes", async () => {
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    const resolvePinnedImage = vi.fn(async () => undefined);
    const firstRemoteResolver = vi.fn(async () => undefined);
    const secondRemoteResolver = vi.fn(async () => undefined);
    const payload = (version: string) => ({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: version },
            {
              type: "image",
              url: "https://media.example.test/shared-versioned.png",
              alt: "Versioned chart",
              title: null,
            },
          ],
        },
      ],
    });
    const renderVersion = async (
      version: string,
      resolveRemoteImageSource: typeof firstRemoteResolver,
    ) => {
      await act(async () => {
        root.render(
          <ReaderDocumentSurface
            fallback={{ content: "fallback", format: "plain" }}
            payload={payload(version)}
            resolveImageSource={resolvePinnedImage}
            resolveRemoteImageSource={resolveRemoteImageSource}
            schema="reader.document.v1"
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    await renderVersion("Version one", firstRemoteResolver);
    expect(firstRemoteResolver).toHaveBeenCalledTimes(1);
    expect(resolvePinnedImage).not.toHaveBeenCalled();

    await renderVersion("Version two", secondRemoteResolver);

    expect(secondRemoteResolver).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('button[data-reader-load-remote-image=""]')
        ?.textContent,
    ).toBe("Retry remote image");
    await act(async () => root.unmount());
  });

  it("coalesces repeated image URLs while keeping every rendered image", async () => {
    let finishResolution: (value: string | undefined) => void = () => undefined;
    const pending = new Promise<string | undefined>((resolve) => {
      finishResolution = resolve;
    });
    const resolveImageSource = vi.fn(() => pending);
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            children: [
              {
                type: "paragraph",
                children: [
                  {
                    type: "image",
                    url: "https://media.example.test/shared.png",
                    alt: "First use",
                    title: null,
                  },
                  {
                    type: "image",
                    url: "https://media.example.test/shared.png",
                    alt: "Second use",
                    title: null,
                  },
                ],
              },
            ],
          }}
          resolveImageSource={resolveImageSource}
          schema="reader.document.v1"
        />,
      );
    });

    expect(resolveImageSource).toHaveBeenCalledTimes(1);
    expect(
      container.querySelectorAll('[data-reader-image="loading"]'),
    ).toHaveLength(2);

    await act(async () => {
      finishResolution("data:image/png;base64,iVBORw0KGgo=");
      await pending;
    });

    expect(
      container.querySelectorAll('img[data-reader-image="resolved"]'),
    ).toHaveLength(2);
    await act(async () => root.unmount());
  });

  it("bounds unique asynchronous image requests per reader surface", async () => {
    readerImageLimits.maxRequestsPerSurface = 32;
    readerImageLimits.maxPendingRequests = 64;
    const resolveImageSource = vi.fn(async () => undefined);
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    const images = Array.from({ length: 33 }, (_, index) => ({
      type: "image" as const,
      url: `https://media.example.test/image-${index}.png`,
      alt: `Image ${index}`,
      title: null,
    }));

    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            children: [{ type: "paragraph", children: images }],
          }}
          resolveImageSource={resolveImageSource}
          schema="reader.document.v1"
        />,
      );
      await Promise.resolve();
    });

    expect(resolveImageSource).toHaveBeenCalledTimes(32);
    expect(
      container.querySelectorAll('[data-reader-image="unresolved"]'),
    ).toHaveLength(33);
    await act(async () => root.unmount());
  });

  it("queues image resolution with bounded global concurrency", async () => {
    const completions: Array<(value: string | undefined) => void> = [];
    const resolveImageSource = vi.fn(
      (_sourceUrl: string, signal: AbortSignal) =>
        new Promise<string | undefined>((resolve) => {
          completions.push(resolve);
          signal.addEventListener("abort", () => resolve(undefined), {
            once: true,
          });
        }),
    );
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            children: [
              {
                type: "paragraph",
                children: Array.from({ length: 10 }, (_, index) => ({
                  type: "image" as const,
                  url: `https://media.example.test/concurrent-${index}.png`,
                  alt: `Concurrent ${index}`,
                  title: null,
                })),
              },
            ],
          }}
          resolveImageSource={resolveImageSource}
          schema="reader.document.v1"
        />,
      );
      await Promise.resolve();
    });

    expect(resolveImageSource).toHaveBeenCalledTimes(6);
    await act(async () => {
      completions.shift()?.(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resolveImageSource).toHaveBeenCalledTimes(7);
    await act(async () => root.unmount());
  });

  it("times out non-cooperative image slots so a later reader surface can resolve", async () => {
    vi.useFakeTimers();
    const blockedContainer = document.createElement("div");
    const laterContainer = document.createElement("div");
    document.body.replaceChildren(blockedContainer, laterContainer);
    const blockedRoot = createRoot(blockedContainer);
    const laterRoot = createRoot(laterContainer);
    const blockingSignals: AbortSignal[] = [];
    const neverSettles = vi.fn((_sourceUrl: string, signal: AbortSignal) => {
      blockingSignals.push(signal);
      return new Promise<string | undefined>(() => undefined);
    });
    let liveBlockingResolversWhenLaterStarted = Number.POSITIVE_INFINITY;
    const resolvesLater = vi.fn(async () => {
      liveBlockingResolversWhenLaterStarted = blockingSignals.filter(
        (signal) => !signal.aborted,
      ).length;
      return "data:image/png;base64,iVBORw0KGgo=";
    });

    try {
      await act(async () => {
        blockedRoot.render(
          <ReaderDocumentSurface
            fallback={{ content: "fallback", format: "plain" }}
            payload={{
              type: "root",
              children: [
                {
                  type: "paragraph",
                  children: Array.from({ length: 6 }, (_, index) => ({
                    type: "image" as const,
                    url: `https://media.example.test/hung-${index}.png`,
                    alt: `Hung ${index}`,
                    title: null,
                  })),
                },
              ],
            }}
            resolveImageSource={neverSettles}
            schema="reader.document.v1"
          />,
        );
      });
      expect(neverSettles).toHaveBeenCalledTimes(6);

      await act(async () => {
        laterRoot.render(
          <ReaderDocumentSurface
            fallback={{ content: "fallback", format: "plain" }}
            payload={{
              type: "root",
              children: [
                {
                  type: "paragraph",
                  children: [
                    {
                      type: "image",
                      url: "https://media.example.test/later.png",
                      alt: "Later chart",
                      title: null,
                    },
                  ],
                },
              ],
            }}
            resolveImageSource={resolvesLater}
            schema="reader.document.v1"
          />,
        );
      });
      expect(resolvesLater).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await Promise.resolve();
      });

      expect(resolvesLater).toHaveBeenCalledTimes(1);
      expect(liveBlockingResolversWhenLaterStarted).toBeLessThan(6);
      expect(
        laterContainer.querySelector('img[data-reader-image="resolved"]'),
      ).not.toBeNull();
    } finally {
      await act(async () => {
        blockedRoot.unmount();
        laterRoot.unmount();
      });
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("bounds pending image work, removes queued aborts, and leaves capacity for later surfaces", async () => {
    readerImageLimits.maxRequestsPerSurface = 32;
    readerImageLimits.maxPendingRequests = 64;
    const firstContainer = document.createElement("div");
    const secondContainer = document.createElement("div");
    const overflowContainer = document.createElement("div");
    const laterContainer = document.createElement("div");
    document.body.replaceChildren(
      firstContainer,
      secondContainer,
      overflowContainer,
      laterContainer,
    );
    const firstRoot = createRoot(firstContainer);
    const secondRoot = createRoot(secondContainer);
    const overflowRoot = createRoot(overflowContainer);
    const laterRoot = createRoot(laterContainer);
    const neverSettles = vi.fn(
      () => new Promise<string | undefined>(() => undefined),
    );
    const overflowResolver = vi.fn(async () => undefined);
    const laterResolver = vi.fn(
      async () => "data:image/png;base64,iVBORw0KGgo=",
    );
    const surface = (prefix: string) => (
      <ReaderDocumentSurface
        fallback={{ content: "fallback", format: "plain" }}
        payload={{
          type: "root",
          children: [
            {
              type: "paragraph",
              children: Array.from({ length: 32 }, (_, index) => ({
                type: "image" as const,
                url: `https://media.example.test/${prefix}-${index}.png`,
                alt: `${prefix} ${index}`,
                title: null,
              })),
            },
          ],
        }}
        resolveImageSource={neverSettles}
        schema="reader.document.v1"
      />
    );

    await act(async () => firstRoot.render(surface("first")));
    await act(async () => secondRoot.render(surface("second")));
    await act(async () => {
      overflowRoot.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            children: [
              {
                type: "paragraph",
                children: [
                  {
                    type: "image",
                    url: "https://media.example.test/overflow.png",
                    alt: "Overflow chart",
                    title: null,
                  },
                ],
              },
            ],
          }}
          resolveImageSource={overflowResolver}
          schema="reader.document.v1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(overflowResolver).not.toHaveBeenCalled();

    await act(async () => {
      firstRoot.unmount();
      secondRoot.unmount();
      await Promise.resolve();
    });
    expect(neverSettles).toHaveBeenCalledTimes(6);

    await act(async () => {
      laterRoot.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            children: [
              {
                type: "paragraph",
                children: [
                  {
                    type: "image",
                    url: "https://media.example.test/after-abort.png",
                    alt: "After abort",
                    title: null,
                  },
                ],
              },
            ],
          }}
          resolveImageSource={laterResolver}
          schema="reader.document.v1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(overflowResolver).not.toHaveBeenCalled();
    expect(laterResolver).toHaveBeenCalledTimes(1);
    expect(
      laterContainer.querySelector('img[data-reader-image="resolved"]'),
    ).not.toBeNull();
    await act(async () => {
      overflowRoot.unmount();
      laterRoot.unmount();
    });
  });

  it("stops retaining resolved data URLs after the per-surface media budget", async () => {
    const largeSafeImage = `data:image/png;base64,${"A".repeat(8_000_000)}`;
    const resolveImageSource = vi.fn(async () => largeSafeImage);
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            children: [
              {
                type: "paragraph",
                children: Array.from({ length: 3 }, (_, index) => ({
                  type: "image" as const,
                  url: `https://media.example.test/large-${index}.png`,
                  alt: `Large ${index}`,
                  title: null,
                })),
              },
            ],
          }}
          resolveImageSource={resolveImageSource}
          schema="reader.document.v1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelectorAll('img[data-reader-image="resolved"]'),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-reader-image="unresolved"]'),
    ).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it("applies the same retained-media budget to synchronous host images", () => {
    const largeSafeImage = `data:image/png;base64,${"A".repeat(8_000_000)}`;
    const surface = renderSurface({
      fallback: { content: "fallback", format: "plain" },
      imageSourceFor: () => largeSafeImage,
      payload: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: Array.from({ length: 3 }, (_, index) => ({
              type: "image" as const,
              url: `https://media.example.test/synchronous-${index}.png`,
              alt: `Synchronous ${index}`,
              title: null,
            })),
          },
        ],
      },
      schema: "reader.document.v1",
    });

    expect(
      surface.querySelectorAll('img[data-reader-image="resolved"]'),
    ).toHaveLength(2);
    expect(
      surface.querySelectorAll('[data-reader-image="unresolved"]'),
    ).toHaveLength(1);
  });

  it("lazily enhances bounded code and TeX while preserving source fallbacks", async () => {
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            losses: [],
            children: [
              {
                type: "code",
                lang: "typescript",
                meta: null,
                value: "const result: number = 1;",
              },
              {
                type: "math",
                display: true,
                format: "tex",
                label: "Energy equation",
                value: "E = mc^2",
              },
              {
                type: "math",
                display: true,
                format: "mathml",
                label: "Preserved MathML source",
                value: "<math><mi>x</mi></math>",
              },
              {
                type: "math",
                display: true,
                format: "mathml",
                label: "Rejected MathML source",
                value: "<math><script>alert(1)</script><mi>x</mi></math>",
              },
            ],
          }}
          schema="reader.document.v2"
        />,
      );
    });

    expect(
      container.querySelector('[data-reader-code="raw"]')?.textContent,
    ).toContain("const result: number = 1;");
    expect(
      container.querySelector('[aria-label="Rejected MathML source"]')
        ?.textContent,
    ).toBe("<math><script>alert(1)</script><mi>x</mi></math>");
    expect(container.querySelector("script")).toBeNull();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        container.querySelector('[data-reader-code="highlighted"]') &&
        container.querySelector('[aria-label="Energy equation"] .katex') &&
        container.querySelector('[aria-label="Preserved MathML source"] math')
      ) {
        break;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }

    expect(
      container.querySelectorAll(".reader-code-token").length,
    ).toBeGreaterThan(1);
    expect(
      container.querySelector('[aria-label="Energy equation"] .katex'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[aria-label="Energy equation"]')
        ?.getAttribute("data-reader-math-status"),
    ).toBe("rendered");
    expect(
      container
        .querySelector('[aria-label="Preserved MathML source"]')
        ?.getAttribute("data-reader-math-status"),
    ).toBe("rendered");
    expect(
      container
        .querySelector('[aria-label="Rejected MathML source"]')
        ?.getAttribute("data-reader-math-status"),
    ).toBe("source");
    await act(async () => root.unmount());
  });

  it.each([
    {
      display: true,
      expectedText: "tr",
      label: "Legacy equation macro",
      value: String.raw`\begin{equation}\newcommand{tr}{\mathop{\text{tr}}}\max_{\boldsymbol{\Phi}} \tr(\boldsymbol{G}^{\top}\boldsymbol{\Phi})\end{equation}`,
    },
    {
      display: true,
      expectedText: "logsumexp",
      label: "Legacy gather macros",
      value:
        "\\begin{gather}\\newcommand{logsumexp}{\\mathop{\\text{logsumexp}}}\\newcommand{softmax}{\\mathop{\\text{softmax}}}\\boldsymbol{x} = (x_1, x_2, \\cdots, x_n) \\in \\mathbb{R}^n \\\\ \\logsumexp(\\boldsymbol{x}) = \\log\\sum_{i=1}^n e^{x_i} \\\\ \\softmax(\\boldsymbol{x}) = \\frac{e^{\\boldsymbol{x}}}{\\sum_{i=1}^n e^{x_i}} \\\\ \\end{gather}",
    },
    {
      display: false,
      expectedText: "msign",
      label: "Legacy inline macro",
      value: String.raw`\newcommand{msign}{\mathop{\text{msign}}}\msign`,
    },
  ])(
    "repairs legacy bare-name newcommand declarations from feed math: $label",
    async ({ display, expectedText, label, value }) => {
      const container = document.createElement("div");
      document.body.replaceChildren(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ReaderDocumentSurface
            fallback={{ content: "fallback", format: "plain" }}
            payload={{
              type: "root",
              losses: [],
              children: display
                ? [
                    {
                      type: "math",
                      display,
                      format: "tex",
                      label,
                      value,
                    },
                  ]
                : [
                    {
                      type: "paragraph",
                      children: [
                        {
                          type: "math",
                          display,
                          format: "tex",
                          label,
                          value,
                        },
                      ],
                    },
                  ],
            }}
            schema="reader.document.v2"
          />,
        );
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          container.querySelector(`[aria-label="${label}"] .katex`) ||
          container.querySelector(`[aria-label="${label}"] .katex-error`)
        ) {
          break;
        }
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
        });
      }

      const formula = container.querySelector(`[aria-label="${label}"]`);
      expect(formula?.querySelector(".katex")).not.toBeNull();
      expect(formula?.querySelector(".katex-error")).toBeNull();
      expect(formula?.getAttribute("data-reader-math-status")).toBe("rendered");
      expect(formula?.textContent).toContain(expectedText);

      await act(async () => root.unmount());
    },
  );

  it("keeps invalid TeX as source instead of treating KaTeX error markup as rendered math", async () => {
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    const value = "\\frac{unterminated";

    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            losses: [],
            children: [
              {
                type: "math",
                display: true,
                format: "tex",
                label: "Invalid feed formula",
                value,
              },
            ],
          }}
          schema="reader.document.v2"
        />,
      );
    });

    const formula = container.querySelector(
      '[aria-label="Invalid feed formula"]',
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (formula?.getAttribute("data-reader-math-enhancement") === "settled") {
        break;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }

    expect(formula?.getAttribute("data-reader-math-enhancement")).toBe(
      "settled",
    );
    expect(formula?.getAttribute("data-reader-math-status")).toBe("source");
    expect(formula?.querySelector(".katex-error")).toBeNull();
    expect(formula?.textContent).toBe(value);

    await act(async () => root.unmount());
  });

  it("renders MathML Core multiscripts without turning content into markup", async () => {
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    const value =
      "<math><mmultiscripts><mi>R</mi><mn>1</mn><none/><mprescripts><mn>3</mn><mtext>&lt;script&gt;alert(1)&lt;/script&gt;</mtext></mprescripts></mmultiscripts></math>";

    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            losses: [],
            children: [
              {
                type: "math",
                display: true,
                format: "mathml",
                label: "Multiscript formula",
                value,
              },
            ],
          }}
          schema="reader.document.v2"
        />,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[aria-label="Multiscript formula"] math'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[aria-label="Multiscript formula"] mmultiscripts',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[aria-label="Multiscript formula"] mmultiscripts mprescripts',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[aria-label="Multiscript formula"] mmultiscripts',
      )?.textContent,
    ).toBe("R13<script>alert(1)</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(
      container
        .querySelector('[aria-label="Multiscript formula"]')
        ?.getAttribute("data-reader-math-status"),
    ).toBe("rendered");

    await act(async () => root.unmount());
  });

  it.each([
    {
      format: "mathml" as const,
      nextValue: "<math><script>alert(1)</script><mi>x</mi></math>",
      scenario: "rejected MathML",
    },
    {
      format: "tex" as const,
      nextValue: "x".repeat(10_001),
      scenario: "over-limit TeX",
    },
  ])(
    "clears a previous KaTeX render before showing $scenario source",
    async ({ format, nextValue }) => {
      const container = document.createElement("div");
      document.body.replaceChildren(container);
      const root = createRoot(container);
      const payloadFor = (nextFormat: "mathml" | "tex", value: string) => ({
        type: "root" as const,
        losses: [],
        children: [
          {
            type: "math" as const,
            display: true,
            format: nextFormat,
            label: "Changing formula",
            value,
          },
        ],
      });

      await act(async () => {
        root.render(
          <ReaderDocumentSurface
            fallback={{ content: "fallback", format: "plain" }}
            payload={payloadFor("tex", "E = mc^2")}
            schema="reader.document.v2"
          />,
        );
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (container.querySelector('[aria-label="Changing formula"] .katex'))
          break;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
        });
      }
      expect(
        container.querySelector('[aria-label="Changing formula"] .katex'),
      ).not.toBeNull();

      await act(async () => {
        root.render(
          <ReaderDocumentSurface
            fallback={{ content: "fallback", format: "plain" }}
            payload={payloadFor(format, nextValue)}
            schema="reader.document.v2"
          />,
        );
      });

      const formula = container.querySelector(
        '[aria-label="Changing formula"]',
      );
      expect(formula?.querySelector(".katex")).toBeNull();
      expect(formula?.getAttribute("data-reader-math-status")).toBe("source");
      expect(formula?.textContent).toBe(nextValue);
      await act(async () => root.unmount());
    },
  );

  it("never turns an asynchronous remote media result into a direct browser request", async () => {
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{ content: "fallback", format: "plain" }}
          payload={{
            type: "root",
            children: [
              {
                type: "paragraph",
                children: [
                  {
                    type: "image",
                    url: "https://media.example.test/private.png",
                    alt: "Private media",
                    title: null,
                  },
                ],
              },
            ],
          }}
          resolveImageSource={async (sourceUrl) => sourceUrl}
          schema="reader.document.v1"
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector('[data-reader-image="unresolved"]')?.textContent,
    ).toBe("Private media");
    await act(async () => root.unmount());
  });

  it("rejects unknown properties at the registered v2 boundary", () => {
    const surface = renderSurface({
      fallback: { content: "Safe v2 fallback", format: "plain" },
      payload: {
        type: "root",
        losses: [],
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: "unsafe", html: "<script />" }],
          },
        ],
      },
      schema: "reader.document.v2",
    });

    expect(
      surface
        .querySelector("[data-reader-fallback]")
        ?.getAttribute("data-reader-fallback"),
    ).toBe("invalid-payload");
    expect(surface.textContent).toContain("Safe v2 fallback");
    expect(surface.querySelector("script")).toBeNull();
  });

  it("explicitly uses the plain-text fallback for an unregistered schema", () => {
    const surface = renderSurface({
      fallback: { content: "Fallback <script>text</script>", format: "plain" },
      payload: { html: "<script>unsafe()</script>" },
      schema: "model.arbitrary-html",
    });

    expect(surface.querySelector('[role="status"]')?.textContent).toContain(
      "Structured view unavailable",
    );
    expect(
      surface
        .querySelector("[data-reader-fallback]")
        ?.getAttribute("data-reader-fallback"),
    ).toBe("unregistered-schema");
    expect(surface.querySelector("script")).toBeNull();
    expect(surface.textContent).toContain("Fallback <script>text</script>");
  });

  it("can keep a known legacy fallback quiet without hiding its provenance", () => {
    const surface = renderSurface({
      fallback: { content: "Preserved article body", format: "plain" },
      payload: undefined,
      schema: "unavailable",
      showFallbackNotice: false,
    });

    expect(surface.querySelector('[role="status"]')).toBeNull();
    expect(
      surface
        .querySelector("[data-reader-fallback]")
        ?.getAttribute("data-reader-fallback"),
    ).toBe("unregistered-schema");
    expect(surface.textContent).toContain("Preserved article body");
  });

  it("preserves native GFM footnote anchors for navigation and excerpt cleanup", () => {
    const surface = renderSurface({
      fallback: {
        content: "Evidence[^1].\n\n[^1]: Supporting detail.",
        format: "gfm",
      },
      payload: undefined,
      schema: "unavailable",
      showFallbackNotice: false,
    });

    expect(surface.querySelector("[data-footnote-ref]")?.tagName).toBe("A");
    expect(surface.querySelector("[data-footnote-backref]")?.tagName).toBe("A");
    expect(surface.querySelector("[data-footnotes]")).not.toBeNull();
  });

  it.each(["toString", "__proto__"])(
    "treats inherited object key %s as an unregistered schema",
    (schema) => {
      const surface = renderSurface({
        fallback: { content: "Safe fallback", format: "plain" },
        payload: { type: "root", children: [] },
        schema,
      });

      expect(
        surface
          .querySelector("[data-reader-fallback]")
          ?.getAttribute("data-reader-fallback"),
      ).toBe("unregistered-schema");
    },
  );

  it("renders the registered safe document schema with host-owned React elements", () => {
    const payload = JSON.stringify({
      type: "root",
      children: [
        {
          type: "heading",
          depth: 2,
          children: [
            { type: "text", value: "A " },
            { type: "strong", children: [{ type: "text", value: "finding" }] },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "emphasis",
              children: [{ type: "text", value: "Measured" }],
            },
            { type: "text", value: " and " },
            { type: "delete", children: [{ type: "text", value: "assumed" }] },
            { type: "text", value: " with " },
            {
              type: "link",
              url: "https://example.test/paper",
              title: "Paper",
              children: [{ type: "text", value: "evidence" }],
            },
            { type: "text", value: " " },
            { type: "inlineCode", value: "p < 0.05" },
            { type: "break" },
            {
              type: "image",
              url: "https://example.test/chart.png",
              alt: "Result chart",
              title: null,
            },
          ],
        },
        {
          type: "blockquote",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", value: "Quoted evidence" }],
            },
          ],
        },
        {
          type: "list",
          ordered: false,
          start: null,
          spread: false,
          children: [
            {
              type: "listItem",
              spread: false,
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", value: "First item" }],
                },
              ],
            },
          ],
        },
        { type: "code", lang: "ts", meta: null, value: "const result = 1;" },
        {
          type: "table",
          children: [
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [{ type: "text", value: "Metric" }],
                },
                {
                  type: "tableCell",
                  children: [{ type: "text", value: "Value" }],
                },
              ],
            },
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [{ type: "text", value: "Accuracy" }],
                },
                {
                  type: "tableCell",
                  children: [{ type: "text", value: "92%" }],
                },
              ],
            },
          ],
        },
        { type: "thematicBreak" },
      ],
    });

    const surface = renderSurface({
      fallback: { content: "This fallback must not render", format: "plain" },
      imageSourceFor: (sourceUrl) =>
        sourceUrl === "https://example.test/chart.png"
          ? "blob:https://reader.test/cached-chart"
          : undefined,
      onOpenLink: () => undefined,
      payload,
      schema: "reader.document.v1",
    });

    expect(surface.querySelector('[role="status"]')).toBeNull();
    expect(surface.querySelector("h2")?.textContent).toBe("A finding");
    expect(surface.querySelector("strong")?.textContent).toBe("finding");
    expect(surface.querySelector("em")?.textContent).toBe("Measured");
    expect(surface.querySelector("del")?.textContent).toBe("assumed");
    expect(
      surface
        .querySelector("a[data-reader-link]")
        ?.getAttribute("data-reader-link"),
    ).toBe("https://example.test/paper");
    expect(surface.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.test/paper",
    );
    expect(surface.querySelector("img")?.getAttribute("src")).toBe(
      "blob:https://reader.test/cached-chart",
    );
    expect(surface.querySelector("img")?.getAttribute("alt")).toBe(
      "Result chart",
    );
    expect(surface.querySelector("p code")?.textContent).toBe("p < 0.05");
    expect(surface.querySelector("br")).not.toBeNull();
    expect(surface.querySelector("blockquote")?.textContent).toContain(
      "Quoted evidence",
    );
    expect(surface.querySelector("ul li")?.textContent).toContain("First item");
    expect(surface.querySelector("pre code.language-ts")?.textContent).toBe(
      "const result = 1;",
    );
    expect(surface.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
    expect(surface.querySelector("pre")?.getAttribute("aria-label")).toBe(
      "Scrollable ts code",
    );
    expect(surface.querySelectorAll("table tr")).toHaveLength(2);
    expect(surface.querySelector("thead th")?.textContent).toBe("Metric");
    expect(surface.querySelector("tbody td")?.textContent).toBe("Accuracy");
    expect(surface.querySelector("hr")).not.toBeNull();
    expect(surface.textContent).not.toContain("This fallback must not render");
  });

  it("does not navigate or fetch source media without host policies", () => {
    const surface = renderSurface({
      fallback: { content: "Safe fallback", format: "plain" },
      payload: JSON.stringify({
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "link",
                url: "https://example.test/paper",
                title: null,
                children: [{ type: "text", value: "paper" }],
              },
              {
                type: "image",
                url: "http://127.0.0.1/private.png",
                alt: "Private image",
                title: null,
              },
            ],
          },
        ],
      }),
      schema: "reader.document.v1",
    });

    expect(surface.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.test/paper",
    );
    expect(surface.querySelector("a")?.hasAttribute("aria-disabled")).toBe(
      false,
    );
    expect(surface.querySelector("img")).toBeNull();
    expect(surface.querySelector("a[data-reader-link]")?.textContent).toBe(
      "paper",
    );
    expect(
      surface.querySelector('[data-reader-image="unresolved"]')?.textContent,
    ).toBe("Private image");
  });

  it("intercepts only an unmodified primary link click", async () => {
    const onOpenLink = vi.fn();
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ReaderDocumentSurface
          fallback={{
            content: "[paper](https://example.test/paper)",
            format: "gfm",
          }}
          onOpenLink={onOpenLink}
          payload={undefined}
          schema="unavailable"
          showFallbackNotice={false}
        />,
      );
    });
    const link = container.querySelector<HTMLAnchorElement>(
      "a[data-reader-link]",
    );
    expect(link).not.toBeNull();

    const modifiedClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    link?.dispatchEvent(modifiedClick);
    expect(modifiedClick.defaultPrevented).toBe(false);
    expect(onOpenLink).not.toHaveBeenCalled();

    const primaryClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    link?.dispatchEvent(primaryClick);
    expect(primaryClick.defaultPrevented).toBe(true);
    expect(onOpenLink).toHaveBeenCalledWith("https://example.test/paper");

    await act(async () => root.unmount());
  });

  it("fails closed to the GFM fallback when a registered payload contains an unsupported node", () => {
    const surface = renderSurface({
      fallback: {
        content:
          "## Preserved fallback\n\n[unsafe link](javascript:alert(1))\n\n<script>unsafe()</script>",
        format: "gfm",
      },
      payload: JSON.stringify({
        type: "root",
        children: [{ type: "html", value: "<script>unsafe()</script>" }],
      }),
      schema: "reader.document.v1",
    });

    expect(
      surface
        .querySelector("[data-reader-fallback]")
        ?.getAttribute("data-reader-fallback"),
    ).toBe("invalid-payload");
    expect(surface.querySelector("h2")?.textContent).toBe("Preserved fallback");
    expect(surface.querySelector("script")).toBeNull();
    expect(surface.querySelector("a")).toBeNull();
    expect(surface.querySelector("[data-reader-link]")).toBeNull();
  });

  it.each([
    [
      "unknown properties",
      JSON.stringify({
        type: "root",
        children: [
          { type: "paragraph", children: [], data: { html: "<script />" } },
        ],
      }),
    ],
    [
      "unsafe URLs",
      JSON.stringify({
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "link",
                url: "javascript:alert(1)",
                title: null,
                children: [{ type: "text", value: "unsafe" }],
              },
            ],
          },
        ],
      }),
    ],
    [
      "invalid MDAST hierarchy",
      JSON.stringify({
        type: "root",
        children: [{ type: "text", value: "not flow content" }],
      }),
    ],
    ["malformed JSON", "{not-json"],
  ])("rejects %s through the public surface boundary", (_case, payload) => {
    const surface = renderSurface({
      fallback: { content: "Safe fallback", format: "plain" },
      payload,
      schema: "reader.document.v1",
    });

    expect(
      surface
        .querySelector("[data-reader-fallback]")
        ?.getAttribute("data-reader-fallback"),
    ).toBe("invalid-payload");
    expect(surface.textContent).toContain("Safe fallback");
  });
});
