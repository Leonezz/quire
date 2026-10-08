import { useMemo } from "react";
import type { ReactNode, Ref } from "react";
import { ReaderDocumentSurface } from "@read/reader";
import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";
import { hostLabel } from "./ArtifactLineage";
import { headerParts } from "./materialMeta";
import { prefsStyle, type ReadingPrefs } from "./readingPrefs";

export type ImageResolver = (url: string, signal: AbortSignal) => Promise<string | undefined>;

export interface ReaderArticleProps {
  material: MaterialRecord;
  content: MaterialViewContent;
  prefs: ReadingPrefs;
  /** Must be stable (useCallback or module-level): the surface keys its image cache by resolver identity. */
  resolveImage: ImageResolver;
  onOpenLink: (url: string) => void;
  /** The app's viewport scrolls itself (and hides its bar); the render harness lets the page grow with the article instead. */
  scrolls?: boolean | undefined;
  viewportRef?: Ref<HTMLDivElement> | undefined;
  bodyRef?: Ref<HTMLElement> | undefined;
  /** An agent artifact's host line opens its sources; without it the line is plain text. */
  onShowSources?: (() => void) | undefined;
  /** Appended to the byline line (the app's "Open original ↗"). */
  bylineExtra?: ReactNode;
  /** Between the byline and the body (the app's quality / text-view banners). */
  banner?: ReactNode;
}

/**
 * The article column as a reader sees it: host, title, byline and the document surface, laid out with the reading prefs.
 * ReaderView wraps it with the reader's chrome; RenderHarness.tsx renders it alone for the eval capture, so the two never drift.
 */
export function ReaderArticle({ material, content, prefs, resolveImage, onOpenLink, scrolls = true, viewportRef, bodyRef, onShowSources, bylineExtra, banner }: ReaderArticleProps) {
  const fallback = useMemo(() => (content.markdown ? { content: content.markdown, format: "gfm" as const } : { content: content.plain ?? "", format: "plain" as const }), [content]);
  const host = hostLabel(material);
  const lineageCount = material.origin === "agent" ? (material.lineage?.length ?? 0) : 0;
  return (
    <div ref={viewportRef} className={`reader-viewport px-14 pb-[120px] pt-12${scrolls ? " overflow-auto" : ""}`} style={prefsStyle(prefs)}>
      <article ref={bodyRef} className="reader-body" style={{ textAlign: prefs.justify ? "justify" : "start" }}>
        {lineageCount && onShowSources
          ? <button type="button" className="mb-3 block cursor-default border-0 bg-transparent p-0 text-[13px] font-medium text-accent-text hover:underline" onClick={onShowSources}>{host} · sources in Info</button>
          : <p className="mb-3 text-[13px] font-medium text-accent-text">{host}</p>}
        <h1>{material.title}</h1>
        <div className="mb-8 flex flex-wrap gap-x-3 text-[12.5px] text-label-2">
          {headerParts(material.meta).map((part) => <span key={part}>{part}</span>)}
          <span>{content.readingMinutes} min</span>
          {bylineExtra}
        </div>
        {banner}
        <ReaderDocumentSurface
          schema={content.reader?.schema ?? "none"}
          payload={content.reader?.payload ?? ""}
          fallback={fallback}
          onOpenLink={onOpenLink}
          resolveImageSource={resolveImage}
          resolveRemoteImageSource={resolveImage}
          showFallbackNotice={false}
        />
      </article>
    </div>
  );
}
