import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  documentReadingPositionKey,
  useDocumentReadingReturn,
  useDocumentReadingPosition,
} from "./useDocumentReadingPosition";
import {
  readRevisionReadingProgress,
} from "./reading-progress";
import type { HorizontalReadingPosition } from "./reveal-article-range";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function defineViewportMetrics(
  viewport: HTMLDivElement,
  { clientHeight = 400, scrollHeight = 2_000 } = {},
) {
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
  });
}

function Harness({
  identity,
  representationIdentity,
  resourceRevisionId,
}: {
  identity: string;
  representationIdentity?: string;
  resourceRevisionId?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useDocumentReadingPosition(
    viewportRef,
    identity,
    resourceRevisionId,
    representationIdentity,
  );
  return <div data-testid="viewport" ref={viewportRef} />;
}

function ReadingReturnHarness({ identity, horizontalPositions, viewportKey }: {
  identity: string;
  horizontalPositions?: readonly HorizontalReadingPosition[];
  viewportKey?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const readingReturn = useDocumentReadingReturn(viewportRef, identity);
  return <>
    <div data-testid="return-viewport" key={viewportKey} ref={viewportRef} />
    <button onClick={() => readingReturn.rememberCurrent(horizontalPositions)} type="button">Remember</button>
    <button disabled={!readingReturn.canReturn} onClick={readingReturn.returnToPrevious} type="button">Return</button>
  </>;
}

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("useDocumentReadingPosition", () => {
  it("restores and flushes a revision-bound document position", async () => {
    const identity = "resource-1@r3:sha256:content-a";
    window.localStorage.setItem(
      documentReadingPositionKey(identity),
      JSON.stringify({ progress: 0.5, scrollHeight: 2_000, top: 800, version: 1 }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <Harness
          identity={identity}
          representationIdentity="sha256:content-a"
          resourceRevisionId="resource-1@r3"
        />,
      ),
    );
    const viewport = container.querySelector<HTMLDivElement>(
      '[data-testid="viewport"]',
    )!;
    defineViewportMetrics(viewport);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(viewport.scrollTop).toBe(800);
    expect(
      readRevisionReadingProgress("resource-1@r3", "sha256:content-a")
        ?.progress,
    ).toBe(0.5);

    viewport.scrollTop = 1_200;
    viewport.dispatchEvent(new Event("scroll"));
    await act(async () => root.unmount());

    expect(
      JSON.parse(
        window.localStorage.getItem(documentReadingPositionKey(identity))!,
      ),
    ).toEqual({ progress: 0.75, scrollHeight: 2_000, top: 1_200, version: 1 });
    expect(
      readRevisionReadingProgress("resource-1@r3", "sha256:content-a")
        ?.progress,
    ).toBe(0.75);
  });

  it("does not reuse a position across immutable revisions", async () => {
    const firstIdentity = "resource-1@r3:sha256:content-a";
    const secondIdentity = "resource-1@r4:sha256:content-a";
    window.localStorage.setItem(
      documentReadingPositionKey(firstIdentity),
      JSON.stringify({ progress: 0.5, scrollHeight: 2_000, top: 800, version: 1 }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Harness identity={secondIdentity} />));
    const viewport = container.querySelector<HTMLDivElement>(
      '[data-testid="viewport"]',
    )!;
    defineViewportMetrics(viewport);
    await act(async () => {
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(viewport.scrollTop).toBe(0);
    await act(async () => root.unmount());
  });

  it("reapplies relative progress when delayed media changes document height", async () => {
    const identity = "resource-1@r3:sha256:content-a";
    window.localStorage.setItem(
      documentReadingPositionKey(identity),
      JSON.stringify({ progress: 0.5, scrollHeight: 2_000, top: 800, version: 1 }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Harness identity={identity} />));
    const viewport = container.querySelector<HTMLDivElement>(
      '[data-testid="viewport"]',
    )!;
    defineViewportMetrics(viewport);
    await act(async () => {
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(viewport.scrollTop).toBe(800);

    defineViewportMetrics(viewport, { clientHeight: 400, scrollHeight: 3_000 });
    await act(async () => {
      viewport.dispatchEvent(new Event("load"));
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(viewport.scrollTop).toBe(1_300);
    await act(async () => root.unmount());
  });

  it("ignores malformed storage without blocking the reader", async () => {
    const identity = "resource-1@r3:sha256:content-a";
    window.localStorage.setItem(documentReadingPositionKey(identity), "not-json");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await expect(
      act(async () => root.render(<Harness identity={identity} />)),
    ).resolves.toBeUndefined();
    await act(async () => root.unmount());
  });
});

describe("useDocumentReadingReturn", () => {
  it("restores moved horizontal regions but preserves unrelated scrolling", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const moved = document.createElement("pre");
    const unrelated = document.createElement("pre");
    moved.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      moved.scrollLeft = typeof options === "number" ? options : options?.left ?? moved.scrollLeft;
    });
    unrelated.scrollTo = vi.fn();
    await act(async () => root.render(<ReadingReturnHarness
      identity="resource-1@r3:sha256:a"
      horizontalPositions={[{ element: moved, left: 100 }]}
    />));
    const viewport = container.querySelector<HTMLDivElement>('[data-testid="return-viewport"]')!;
    viewport.append(moved, unrelated);
    const [remember, back] = container.querySelectorAll("button");
    viewport.scrollTop = 600;
    await act(async () => remember!.click());
    viewport.scrollTop = 120;
    moved.scrollLeft = 1_000;
    unrelated.scrollLeft = 75;

    await act(async () => back!.click());
    expect(viewport.scrollTop).toBe(600);
    expect(moved.scrollLeft).toBe(100);
    expect(unrelated.scrollLeft).toBe(75);
    expect(unrelated.scrollTo).not.toHaveBeenCalled();
    expect(back!.disabled).toBe(true);
    expect(window.localStorage.length).toBe(0);
    await act(async () => root.unmount());
  });

  it.each(["detached", "moved-outside"])("ignores a %s scroller when returning", async (mode) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const moved = document.createElement("pre");
    moved.scrollTo = vi.fn();
    await act(async () => root.render(<ReadingReturnHarness
      identity="resource-1@r3"
      horizontalPositions={[{ element: moved, left: 100 }]}
    />));
    const viewport = container.querySelector<HTMLDivElement>('[data-testid="return-viewport"]')!;
    viewport.append(moved);
    const [remember, back] = container.querySelectorAll("button");
    viewport.scrollTop = 600;
    await act(async () => remember!.click());
    viewport.scrollTop = 120;
    if (mode === "detached") moved.remove();
    else document.body.append(moved);

    await act(async () => back!.click());
    expect(moved.scrollTo).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(600);
    await act(async () => root.unmount());
  });

  it("does not restore an origin into a replacement viewport", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<ReadingReturnHarness identity="resource-1@r3" viewportKey="first" />));
    const viewport = () => container.querySelector<HTMLDivElement>('[data-testid="return-viewport"]')!;
    viewport().scrollTop = 600;
    const [remember, back] = container.querySelectorAll("button");
    await act(async () => remember!.click());
    await act(async () => root.render(<ReadingReturnHarness identity="resource-1@r3" viewportKey="replacement" />));
    viewport().scrollTop = 180;

    await act(async () => back!.click());
    expect(viewport().scrollTop).toBe(180);
    expect(back!.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it("returns from a deep-link jump to the captured reading position", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ReadingReturnHarness identity="resource-1@r3" />));
    const viewport = container.querySelector<HTMLDivElement>(
      '[data-testid="return-viewport"]',
    )!;
    const remember = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Remember",
    )!;
    const returnButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Return",
    )!;

    viewport.scrollTop = 640;
    await act(async () => remember.click());
    expect(returnButton.disabled).toBe(false);

    viewport.scrollTop = 120;
    await act(async () => returnButton.click());
    expect(viewport.scrollTop).toBe(640);
    expect(returnButton.disabled).toBe(true);

    await act(async () => root.unmount());
  });

  it.each(["resource-1@r4:sha256:a", "resource-1@r3:sha256:b"])("does not carry a deep-link origin into %s", async (nextIdentity) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    const moved = document.createElement("pre");
    moved.scrollTo = vi.fn();
    await act(async () => root.render(<ReadingReturnHarness
      identity="resource-1@r3:sha256:a"
      horizontalPositions={[{ element: moved, left: 100 }]}
    />));
    const viewport = container.querySelector<HTMLDivElement>(
      '[data-testid="return-viewport"]',
    )!;
    viewport.append(moved);
    const buttons = () => Array.from(container.querySelectorAll("button"));
    viewport.scrollTop = 480;
    await act(async () => buttons()[0]!.click());
    expect(buttons()[1]!.disabled).toBe(false);

    await act(async () => root.render(<ReadingReturnHarness identity={nextIdentity} />));
    expect(buttons()[1]!.disabled).toBe(true);
    await act(async () => buttons()[1]!.click());
    expect(moved.scrollTo).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
