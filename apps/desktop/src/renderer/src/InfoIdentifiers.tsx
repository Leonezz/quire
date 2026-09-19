import { ExternalLink } from "lucide-react";
import { Button } from "@read/ui";
import { MATERIAL_KIND_FIELDS, type MaterialKind } from "../../shared/contracts";
import { arxivUrl, doiUrl } from "./materialMeta";
import { MetaTextField, type TextMetaField } from "./InfoFields";
import type { MaterialMetaEditor } from "./useMaterialMeta";

type Identifier = "doi" | "arxivId" | "isbn" | "issn" | "url";
const ORDER: readonly Identifier[] = ["doi", "arxivId", "isbn", "issn", "url"];
const linkOf: Partial<Record<Identifier, (value: string) => string>> = { doi: doiUrl, arxivId: arxivUrl, url: (value) => value };

/** DOI, arXiv id, ISBN, ISSN (those the kind lists, or that have a value) and the URL — the linkable ones with an Open button. */
export function InfoIdentifiers({ editor, kind, onOpenLink }: { editor: MaterialMetaEditor; kind: MaterialKind; onOpenLink: (url: string) => void }) {
  const listed = MATERIAL_KIND_FIELDS[kind];
  const shown = ORDER.filter((field) => field === "url" || listed.includes(field) || editor.meta[field]);
  return (
    <div className="grid gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-[.07em] text-label-3">Identifiers</span>
      {shown.map((field) => {
        const value = editor.meta[field]?.trim();
        const link = linkOf[field];
        const open = link && value ? (
          <Button size="md" variant="quiet" aria-label={`Open ${field === "url" ? "URL" : field === "doi" ? "DOI" : "arXiv"} in the browser`} className="h-9 shrink-0 gap-1 px-2.5" onPress={() => onOpenLink(link(value))}>Open<ExternalLink /></Button>
        ) : undefined;
        return <MetaTextField key={field} editor={editor} field={field as TextMetaField} trailing={open} />;
      })}
    </div>
  );
}
