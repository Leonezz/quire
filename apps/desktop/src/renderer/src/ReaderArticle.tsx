import { useMemo } from "react";
import type { ReactNode, Ref } from "react";
import { ReaderDocumentSurface } from "@read/reader";
import type { ArtifactInfo, ArtifactType, MaterialRecord, MaterialViewContent } from "../../shared/contracts";
import { ArtifactSurface } from "./ArtifactCitations";
import { ArtifactCanvas } from "./ArtifactFrame";
import { hostLabel } from "./ArtifactLineage";
import { headerParts } from "./materialMeta";
import { prefsStyle, type ReadingPrefs } from "./readingPrefs";

const ignoreMaterial = () => undefined;

const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = { markdown: "", code: "Code", html: "HTML", svg: "SVG", react: "Interactive", mermaid: "Diagram" };

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
}

/**
 * The article column as a reader sees it: host, title, byline and the document surface, laid out with the reading prefs.
 * ReaderView wraps it with the reader's chrome; RenderHarness.tsx renders it alone for the eval capture, so the two never drift.
 */
export function ReaderArticle({ material, content, prefs, resolveImage, onOpenLink, onOpenMaterial, scrolls = true, viewportRef, bodyRef, onShowSources, bylineExtra, banner, onFixArtifact }: ReaderArticleProps) {
  const fallback = useMemo(() => (content.markdown ? { content: content.markdown, format: "gfm" as const } : { content: content.plain ?? "", format: "plain" as const }), [content]);
  const surface = { schema: content.reader?.schema ?? "none", payload: content.reader?.payload ?? "", fallback, onOpenLink, resolveImageSource: resolveImage, resolveRemoteImageSource: resolveImage, showFallbackNotice: false };
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
          {artifactLabel(material.artifact) ? <span>{artifactLabel(material.artifact)}</span> : null}
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
