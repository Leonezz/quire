import { Fragment, useCallback, useMemo, useRef, type ReactNode } from "react";
import { ReaderDocumentSurface, type ReaderDocumentSurfaceProps } from "@read/reader";
import type { MaterialRecord, MaterialSummary } from "../../shared/contracts";
import { numberSources, splitCitations, type CitationSource } from "./citations";
import { displayDate } from "./materialMeta";
import { useMaterialTitles } from "./useMaterialTitles";

// An agent artifact as a reader sees it: every `[material-id]` in its text is a numbered reference
// mark (hover names the source and the quoted passage, a click opens the source at that passage), and
// a Sources list at the end resolves each number to its title, author and where it appeared. The ids
// stay in the stored Markdown; only the rendering resolves them, so a renamed source shows its new title.

type OpenMaterial = (id: string, quote?: string) => void;

export interface ResolvedSource extends CitationSource {
  summary: MaterialSummary | undefined;
}

function sourceTitle(source: ResolvedSource, loaded: boolean): string {
  if (source.summary) return source.summary.title;
  return loaded ? `Material ${source.id.slice(0, 8)} (no longer in the library)` : "…";
}

/** "Jane Doe · Example Journal · 3 May 2024": who, where and when, as far as the summary knows. */
function sourceDetail(summary: MaterialSummary): string {
  let host = "";
  if (summary.origin === "agent") host = "Written by the agent";
  else if (summary.origin !== "file") { try { host = new URL(summary.url).hostname; } catch { host = ""; } }
  return [summary.byline, summary.publication ?? host, displayDate(summary.publishedAt)].filter(Boolean).join(" · ");
}

/** A mark is trusted when the source was listed in the artifact's lineage and is still in the library. */
function trusted(source: ResolvedSource, loaded: boolean): boolean {
  return source.listed && (!loaded || source.summary !== undefined);
}

function markTitle(source: ResolvedSource, loaded: boolean, quote: string | undefined): string {
  const note = source.listed ? "" : " (not among the sources the agent read for this artifact)";
  return `[${source.number}] ${sourceTitle(source, loaded)}${note}${quote ? `\n“${quote}”` : ""}`;
}

function CitationMark({ sources, quote, loaded, onOpenMaterial }: { sources: ResolvedSource[]; quote: string | undefined; loaded: boolean; onOpenMaterial: OpenMaterial }) {
  return (
    <sup className="artifact-citation whitespace-nowrap font-mono text-[0.72em] font-semibold leading-none text-accent-text" data-artifact-citation="">
      [
      {sources.map((source, index) => {
        // Several sources for one claim share the quote before them: it is the passage of the first.
        const carried = index === 0 ? quote : undefined;
        const ok = trusted(source, loaded);
        return (
          <Fragment key={source.id}>
            {index > 0 ? ", " : null}
            <button
              type="button"
              className={`cursor-default border-0 bg-transparent p-0 font-[inherit] hover:underline focus-visible:rounded-[3px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-ring ${ok ? "text-accent-text" : "text-label-3 underline decoration-dashed underline-offset-2"}`}
              title={markTitle(source, loaded, carried)}
              aria-label={`Source ${source.number}: ${sourceTitle(source, loaded)}${ok ? "" : " (unverified citation)"}`}
              data-source={source.id}
              data-quote={carried}
              data-unverified={ok ? undefined : true}
              onClick={() => (carried ? onOpenMaterial(source.id, carried) : onOpenMaterial(source.id))}
            >
              {source.number}
            </button>
          </Fragment>
        );
      })}
      ]
    </sup>
  );
}

/** The artifact's numbered source list: what each reference mark points at. */
export function ArtifactSources({ sources, loaded, onOpenMaterial }: { sources: readonly ResolvedSource[]; loaded: boolean; onOpenMaterial: OpenMaterial }) {
  if (sources.length === 0) return null;
  return (
    <section aria-label="Sources" className="artifact-sources mt-12 border-t border-separator pt-4 text-[13px] leading-[19px] text-label-2" style={{ textAlign: "start" }}>
      <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-label-3">Sources</p>
      <ol className="m-0 grid list-none gap-2 p-0">
        {sources.map((source) => {
          const detail = source.summary ? sourceDetail(source.summary) : "";
          const notes = [!source.cited ? "drawn on, not cited in the text" : "", !source.listed ? "not among the sources the agent read" : ""].filter(Boolean);
          return (
            <li key={source.id} id={`artifact-source-${source.number}`} className="m-0 grid grid-cols-[2.2em_1fr] p-0">
              <span className="font-mono text-[12px] text-label-3">[{source.number}]</span>
              <span className="min-w-0">
                <button type="button" className="cursor-default border-0 bg-transparent p-0 text-left font-[inherit] text-label hover:text-accent-text disabled:text-label-3" disabled={loaded && !source.summary} onClick={() => onOpenMaterial(source.id)}>
                  {sourceTitle(source, loaded)}
                </button>
                {detail || notes.length > 0 ? <span className="block text-[12px] text-label-3">{[detail, ...notes].filter(Boolean).join(" · ")}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The resolved citations of an artifact: a stable `renderText` for the reader surface (turns citation
 * runs into numbered marks) and the numbered sources for the list at the end.
 */
export function useArtifactCitations(material: Pick<MaterialRecord, "lineage">, markdown: string | undefined, onOpenMaterial: OpenMaterial) {
  const { summaries } = useMaterialTitles();
  const loaded = summaries !== undefined;
  const sources = useMemo<ResolvedSource[]>(
    () => numberSources(markdown ?? "", material.lineage ?? []).map((source) => ({ ...source, summary: summaries?.get(source.id) })),
    [markdown, material.lineage, summaries],
  );
  // Through a ref, so a new handler identity does not make the surface re-render its whole document.
  const open = useRef(onOpenMaterial);
  open.current = onOpenMaterial;
  const openMaterial = useCallback<OpenMaterial>((id, quote) => (quote ? open.current(id, quote) : open.current(id)), []);
  const renderText = useCallback((value: string): ReactNode => {
    const parts = splitCitations(value);
    if (parts.length === 1 && typeof parts[0] === "string") return value;
    const byId = new Map(sources.map((source) => [source.id, source]));
    return parts.map((part, index) => {
      if (typeof part === "string") return <Fragment key={index}>{part}</Fragment>;
      const marked = part.ids.map((id) => byId.get(id)).filter((source): source is ResolvedSource => source !== undefined);
      if (marked.length === 0) return <Fragment key={index}>{` [${part.ids.join(", ")}]`}</Fragment>;
      return <CitationMark key={index} sources={marked} quote={part.quote} loaded={loaded} onOpenMaterial={openMaterial} />;
    });
  }, [sources, loaded, openMaterial]);
  return { sources, loaded, renderText };
}

/** The reader surface for an agent artifact, with its citations resolved and its Sources list after the text. */
export function ArtifactSurface({ material, markdown, onOpenMaterial, ...surface }: Omit<ReaderDocumentSurfaceProps, "renderText"> & { material: Pick<MaterialRecord, "lineage">; markdown: string | undefined; onOpenMaterial: OpenMaterial }) {
  const { sources, loaded, renderText } = useArtifactCitations(material, markdown, onOpenMaterial);
  return (
    <>
      <ReaderDocumentSurface {...surface} renderText={renderText} />
      <ArtifactSources sources={sources} loaded={loaded} onOpenMaterial={onOpenMaterial} />
    </>
  );
}
