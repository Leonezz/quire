import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { ReaderDocumentSurface } from "@read/reader";
import { formatMediaClock } from "@read/ui";
import { IMAGE_SCHEME, type ArtifactInfo, type ArtifactType, type MaterialRecord, type MaterialViewContent } from "../../shared/contracts";
import { ArtifactSurface } from "./ArtifactCitations";
import { ArtifactCanvas } from "./ArtifactFrame";
import { hostLabel } from "./ArtifactLineage";
import { headerParts } from "./materialMeta";
import { prefsStyle, type ReadingPrefs } from "./readingPrefs";

const ignoreMaterial = () => undefined;
/** What resolveImage answers with in the app: main serves it from disk (image-protocol.ts). */
const HOST_IMAGE_SCHEMES = [`${IMAGE_SCHEME}:`] as const;

const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = { markdown: "", code: "Code", html: "HTML", svg: "SVG", react: "Interactive", mermaid: "Diagram" };

/** When an artifact was last written, as the byline shows it: "Oct 15, 2026". */
export function artifactDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "Interactive", "Code (python)" for an artifact that is not plain Markdown; empty otherwise. Its versions are the reader's (ArtifactVersions.tsx). */
export function artifactLabel(artifact: ArtifactInfo | undefined): string {
  if (!artifact) return "";
  return artifact.type === "code" && artifact.language ? `${ARTIFACT_TYPE_LABELS.code} (${artifact.language})` : ARTIFACT_TYPE_LABELS[artifact.type];
}

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
  /** Opens a cited material (at the passage the citation quotes); with it an agent artifact's citations become numbered references and a Sources list. */
  onOpenMaterial?: ((id: string, quote?: string) => void) | undefined;
  /** An agent artifact's host line opens its sources; without it the line is plain text. */
  onShowSources?: (() => void) | undefined;
  /** Appended to the byline line (the app's "Open original ↗"). */
  bylineExtra?: ReactNode;
  /** Between the byline and the body (the app's quality / text-view banners). */
  banner?: ReactNode;
  /** Hands an error an artifact hit while running to the agent, to fix the artifact. */
  onFixArtifact?: ((error: string) => void) | undefined;
  /** Transcript view: the currently spoken paragraph index, highlighted with a calm left rule. */
  activeParagraphIndex?: number | undefined;
  /** Transcript view: seeks and plays from a clicked margin timestamp. */
  onSeekTime?: ((seconds: number) => void) | undefined;
  /** Video materials: clicking an inline keyframe `<figure>` expands the top video stage at that timestamp. */
  onSelectKeyframeTime?: ((seconds: number) => void) | undefined;
}

interface MarginStamp {
  paragraphIndex: number;
  startSec: number;
  top: number;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as { current: T | null }).current = value;
}

function parseCaptionTimestamp(text: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\b/.exec(text.trim());
  if (!m) return undefined;
  if (m[3] !== undefined) {
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * The article column as a reader sees it: host, title, byline and the document surface, laid out with the reading prefs.
 * ReaderView wraps it with the reader's chrome; RenderHarness.tsx renders it alone for the eval capture, so the two never drift.
 */
export function ReaderArticle({ material, content, prefs, resolveImage, onOpenLink, onOpenMaterial, scrolls = true, viewportRef, bodyRef, onShowSources, bylineExtra, banner, onFixArtifact, activeParagraphIndex, onSeekTime, onSelectKeyframeTime }: ReaderArticleProps) {
  const articleRef = useRef<HTMLElement | null>(null);
  const setBodyRefs = useCallback((node: HTMLElement | null) => {
    articleRef.current = node;
    assignRef(bodyRef, node);
  }, [bodyRef]);
  const [stamps, setStamps] = useState<MarginStamp[]>([]);
  const timeAnchors = content.timeAnchors;

  useEffect(() => {
    const article = articleRef.current;
    if (!article || !timeAnchors || timeAnchors.length === 0) {
      setStamps([]);
      return;
    }
    const syncLayout = () => {
      const paragraphs = article.querySelectorAll<HTMLParagraphElement>(".reader-document > p");
      let prevSpeaker: string | undefined;
      const measured: MarginStamp[] = [];
      paragraphs.forEach((p) => p.removeAttribute("data-speaker"));
      for (const anchor of timeAnchors) {
        const p = paragraphs[anchor.paragraphIndex];
        if (!p) continue;
        if (anchor.speaker && anchor.speaker !== prevSpeaker) {
          p.setAttribute("data-speaker", anchor.speaker);
        }
        prevSpeaker = anchor.speaker;
        measured.push({
          paragraphIndex: anchor.paragraphIndex,
          startSec: anchor.startSec,
          top: p.offsetTop,
        });
      }
      setStamps(measured);
    };

    const frame = requestAnimationFrame(syncLayout);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(syncLayout);
      observer.observe(article);
    }
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [timeAnchors, content.reader?.payload, prefs]);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const paragraphs = article.querySelectorAll<HTMLParagraphElement>(".reader-document > p");
    paragraphs.forEach((p, idx) => {
      if (activeParagraphIndex !== undefined && idx === activeParagraphIndex) {
        p.setAttribute("data-active-turn", "true");
      } else {
        p.removeAttribute("data-active-turn");
      }
    });
  }, [activeParagraphIndex, timeAnchors, content.reader?.payload]);

  const fallback = useMemo(() => (content.markdown ? { content: content.markdown, format: "gfm" as const } : { content: content.plain ?? "", format: "plain" as const }), [content]);
  const surface = { schema: content.reader?.schema ?? "none", payload: content.reader?.payload ?? "", fallback, onOpenLink, hostImageSchemes: HOST_IMAGE_SCHEMES, resolveImageSource: resolveImage, resolveRemoteImageSource: resolveImage, showFallbackNotice: false };
  const host = hostLabel(material);
  const lineageCount = material.origin === "agent" ? (material.lineage?.length ?? 0) : 0;
  const handleArticleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!onSelectKeyframeTime || !(event.target instanceof Element)) return;
    if (event.target.closest("a, button")) return;
    const figure = event.target.closest(".reader-document figure");
    if (!figure) return;
    const caption = figure.querySelector("figcaption")?.textContent ?? "";
    const sec = parseCaptionTimestamp(caption);
    if (sec !== undefined) {
      onSelectKeyframeTime(sec);
    }
  }, [onSelectKeyframeTime]);

  return (
    <div ref={viewportRef} className={`reader-viewport px-14 ${material.media ? "pb-[156px]" : "pb-[120px]"} pt-12${scrolls ? " overflow-auto" : ""}`} style={prefsStyle(prefs)}>
      <article ref={setBodyRefs} onClick={onSelectKeyframeTime ? handleArticleClick : undefined} data-video-figures={onSelectKeyframeTime ? "true" : undefined} className="reader-body relative" style={{ textAlign: prefs.justify ? "justify" : "start" }}>
        {stamps.length > 0 ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 -left-13 w-11 select-none">
            {stamps.map((stamp) => {
              const isActive = activeParagraphIndex === stamp.paragraphIndex;
              return (
                <button
                  key={`${stamp.paragraphIndex}-${stamp.startSec}`}
                  type="button"
                  tabIndex={-1}
                  onClick={() => onSeekTime?.(stamp.startSec)}
                  style={{ top: stamp.top + 3 }}
                  className={`pointer-events-auto absolute right-0 cursor-pointer rounded-control border-0 bg-transparent px-1 py-0.5 font-mono text-[11px] leading-[15px] tabular-nums transition-colors hover:bg-fill hover:text-label ${isActive ? "font-semibold text-accent-text" : "text-label-3"}`}
                >
                  {formatMediaClock(stamp.startSec)}
                </button>
              );
            })}
          </div>
        ) : null}
        {lineageCount && onShowSources
          ? <button type="button" className="mb-3 block cursor-default border-0 bg-transparent p-0 text-[13px] font-medium text-accent-text hover:underline" onClick={onShowSources}>{host} · sources in Info</button>
          : <p className="mb-3 text-[13px] font-medium text-accent-text">{host}</p>}
        <h1>{material.title}</h1>
        <div className="mb-8 flex flex-wrap gap-x-3 text-[12.5px] text-label-2">
          {headerParts(material.meta).map((part) => <span key={part}>{part}</span>)}
          {artifactLabel(material.artifact) ? <span>{artifactLabel(material.artifact)}</span> : null}
          {material.origin === "agent" && material.artifact ? <span>{artifactDate(material.artifact.updatedAt)}</span> : null}
          <span>{content.readingMinutes} min</span>
          {bylineExtra}
        </div>
        {banner}
        {content.artifactBody ? null : material.origin === "agent" && onOpenMaterial
          ? <ArtifactSurface material={material} markdown={content.markdown} onOpenMaterial={onOpenMaterial} {...surface} />
          : <ReaderDocumentSurface {...surface} />}
      </article>
      {/* An artifact that renders outside the reader takes the column's full width, not the reading measure. */}
      {content.artifactBody ? <ArtifactCanvas material={material} artifact={content.artifactBody} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial ?? ignoreMaterial} onFix={onFixArtifact} /> : null}
    </div>
  );
}
