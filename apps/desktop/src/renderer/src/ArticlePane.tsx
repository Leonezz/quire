import { useEffect, useMemo, useState } from "react";
import { ReaderDocumentSurface } from "@read/reader";
import { Button, Kbd } from "@read/ui";
import type { MaterialRecord, MaterialSummary } from "../../shared/contracts";
import { read } from "./api";
import { loadPrefs, prefsStyle } from "./readingPrefs";

/** The Library's right pane: the article itself, readable in place; Open goes to the full reader. */
export function ArticlePane({ summary, onOpen, onOpenLink }: { summary: MaterialSummary; onOpen: () => void; onOpenLink: (url: string) => void }) {
  const [material, setMaterial] = useState<MaterialRecord | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const prefs = useMemo(() => loadPrefs(), [summary.id]);

  useEffect(() => {
    let cancelled = false;
    setMaterial(undefined); setError(undefined);
    read.getMaterial(summary.id)
      .then((record) => { if (cancelled) return; if (record) setMaterial(record); else setError("This material is no longer in the library."); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load the material."); });
    return () => { cancelled = true; };
  }, [summary.id]);

  const host = summary.origin === "file" ? "Local file" : new URL(summary.url).hostname;
  const fallback = material ? (material.markdown ? { content: material.markdown, format: "gfm" as const } : { content: material.plain ?? "", format: "plain" as const }) : { content: "", format: "plain" as const };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" style={prefsStyle(prefs)}>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-separator-soft bg-content/85 px-9 py-3 backdrop-blur">
        <span className="min-w-0 truncate text-[12.5px] text-label-2">{host}{summary.byline ? ` · ${summary.byline}` : ""} · {summary.readingMinutes} min</span>
        <Button variant="primary" size="sm" className="ml-auto" onPress={onOpen}>Open <Kbd>↵</Kbd></Button>
      </div>
      <article className="reader-body px-9 pb-16 pt-8">
        <h1>{summary.title}</h1>
        {error ? <p role="alert" className="text-red">{error}</p> : null}
        {material?.pdf ? (
          <p className="text-label-2">A PDF of {material.pdf.pages} pages. Open it to read with page thumbnails, search and highlights.</p>
        ) : material ? (
          <ReaderDocumentSurface schema={material.reader?.schema ?? "none"} payload={material.reader?.payload ?? ""} fallback={fallback} onOpenLink={onOpenLink} resolveImageSource={(url) => read.resolveImage(url)} resolveRemoteImageSource={(url) => read.resolveImage(url)} showFallbackNotice={false} />
        ) : !error ? <p className="text-label-3">Opening…</p> : null}
      </article>
    </div>
  );
}
