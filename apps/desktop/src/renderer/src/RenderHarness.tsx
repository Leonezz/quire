import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";
import { isPreview, read } from "./api";
import { contentOfRecord, isPdfContent } from "./materialViews";
import { ReaderArticle, type ImageResolver } from "./ReaderArticle";
import { DEFAULT_PREFS } from "./readingPrefs";
import { proxyImageResolver, RENDER_TIMEOUT_MS, waitForArticleReady, type RenderTheme } from "./renderReadiness";

// The eval capture's page (`?render=<id>`, see renderReadiness.ts for the flags it sets on <html>): the article
// column exactly as ReaderView shows it — the same ReaderArticle, the default reading settings (stored ones are
// ignored), a fixed theme — and nothing else: no sidebar, toolbar, banners or panels.

export interface RenderHarnessProps {
  id: string;
  /** The column's width in CSS pixels; the window's width when omitted. */
  width?: number | undefined;
  theme?: RenderTheme | undefined;
  /** How long to wait for images, math and fonts before reporting ready with a warning. */
  timeoutMs?: number | undefined;
}

type Loaded = { status: "loading" } | { status: "ready"; material: MaterialRecord; content: MaterialViewContent } | { status: "error"; message: string };

const html = () => document.documentElement;
const ignoreLink = () => undefined;

function setFlag(name: "renderReady" | "renderWarning" | "renderError", value: string | undefined) {
  if (value === undefined) delete html().dataset[name]; else html().dataset[name] = value;
}

/** The primary view's document content, or why the harness cannot render it. */
async function loadArticle(id: string): Promise<{ material: MaterialRecord; content: MaterialViewContent }> {
  const material = await read.getMaterial(id);
  if (!material) throw new Error(`No material with id "${id}" (the preview corpus is public/dev/corpus/<id>.json; run the eval export).`);
  const content = contentOfRecord(material);
  if (isPdfContent(content)) throw new Error(`Material "${id}" is a PDF; the render harness renders document views only.`);
  if (!content.reader) throw new Error(`Material "${id}" has no reader payload (reader.document); re-run the eval export.`);
  return { material, content };
}

/** Marks the page as a render harness for the length of the mount: the theme is fixed, and the page grows with the article. */
function useHarnessDocument(theme: RenderTheme) {
  useLayoutEffect(() => {
    const root = html();
    const previousTheme = root.dataset.theme;
    root.dataset.render = "";
    root.dataset.theme = theme;
    return () => {
      delete root.dataset.render;
      if (previousTheme === undefined) delete root.dataset.theme; else root.dataset.theme = previousTheme;
      setFlag("renderReady", undefined); setFlag("renderWarning", undefined); setFlag("renderError", undefined);
    };
  }, [theme]);
}

export function RenderHarness({ id, width, theme = "light", timeoutMs = RENDER_TIMEOUT_MS }: RenderHarnessProps) {
  useHarnessDocument(theme);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const bodyRef = useRef<HTMLElement>(null);
  const warnings = useRef(new Set<string>());
  const noteProxyMissing = useCallback(() => { warnings.current.add("image-proxy-missing"); }, []);
  // Stable for the mount: the surface keys its image cache by resolver identity.
  const resolveImage = useMemo<ImageResolver>(() => (isPreview ? proxyImageResolver(noteProxyMissing) : (url) => read.resolveImage(url)), [noteProxyMissing]);

  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: "loading" });
    loadArticle(id)
      .then((article) => { if (!cancelled) setLoaded({ status: "ready", ...article }); })
      .catch((cause: unknown) => { if (!cancelled) setLoaded({ status: "error", message: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (loaded.status === "error") { setFlag("renderError", loaded.message); return; }
    const root = bodyRef.current;
    if (loaded.status !== "ready" || !root) return;
    const controller = new AbortController();
    waitForArticleReady(root, { timeoutMs, signal: controller.signal })
      .then((pending) => {
        const fallback = root.querySelector<HTMLElement>("[data-reader-fallback]")?.dataset.readerFallback;
        const all = [...pending, ...warnings.current, ...(fallback ? [`reader-fallback:${fallback}`] : [])];
        setFlag("renderWarning", all.length ? all.join(" ") : undefined);
        setFlag("renderReady", "1");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => controller.abort();
  }, [loaded, timeoutMs]);

  if (loaded.status === "error") {
    return <div role="alert" data-render-error-message="" className="min-h-screen bg-content p-10 text-[15px] text-red-text">Render failed: {loaded.message}</div>;
  }
  return (
    <div data-render-article="" className="min-h-screen bg-content" style={width === undefined ? undefined : { width: `${width}px` }}>
      {loaded.status === "ready"
        ? <ReaderArticle material={loaded.material} content={loaded.content} prefs={DEFAULT_PREFS} resolveImage={resolveImage} onOpenLink={ignoreLink} scrolls={false} bodyRef={bodyRef} />
        : <p className="p-10 text-[13px] text-label-3">Loading {id}…</p>}
    </div>
  );
}

/** A malformed `?render=` query: shown and flagged like any other render failure. */
export function RenderQueryError({ message }: { message: string }) {
  useHarnessDocument("light");
  useEffect(() => { setFlag("renderError", message); }, [message]);
  return <div role="alert" data-render-error-message="" className="min-h-screen bg-content p-10 text-[15px] text-red-text">Render failed: {message}</div>;
}
