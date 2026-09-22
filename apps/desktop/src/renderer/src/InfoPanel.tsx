import { useEffect, useState } from "react";
import { InspectorSection, MenuSelect, TagInput } from "@read/ui";
import type { MaterialRecord } from "../../shared/contracts";
import { read } from "./api";
import { InfoActions } from "./InfoActions";
import { InfoCreators } from "./InfoCreators";
import { ExtractedLine, InfoFields, MetaTextField } from "./InfoFields";
import { InfoFacts } from "./InfoFacts";
import { InfoIdentifiers } from "./InfoIdentifiers";
import { InfoRelated } from "./InfoRelated";
import { KIND_LABELS, MATERIAL_KINDS, isMaterialKind } from "./materialMeta";
import type { RebuildProps } from "./RebuildBanner";
import { useMaterialMeta, type MaterialMetaEditor } from "./useMaterialMeta";
import type { MaterialViewController } from "./useMaterialView";

const kindOptions = MATERIAL_KINDS.map((kind) => ({ id: kind, label: KIND_LABELS[kind] }));
/** One shared empty list: a fresh `[]` per render would retrigger the sync effects below forever. */
const NO_TAGS: readonly string[] = [];

/** The kind selector at the top: it decides which fields follow. */
function KindField({ editor }: { editor: MaterialMetaEditor }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[12.5px] font-medium text-label-2">Type</span>
      <MenuSelect aria-label="Type" variant="default" size="md" className="justify-self-start" value={editor.meta.kind ?? "webpage"} options={kindOptions} isDisabled={editor.saving === "kind"}
        onChange={(kind) => { if (isMaterialKind(kind)) void editor.save({ kind }); }} />
      {editor.errors.kind ? <p role="alert" className="m-0 text-[12px] text-red">{editor.errors.kind}</p> : null}
      <ExtractedLine editor={editor} field="kind" />
    </div>
  );
}

function TagsField({ editor }: { editor: MaterialMetaEditor }) {
  const saved = editor.meta.tags ?? NO_TAGS;
  const savedKey = saved.join("\n");
  const [tags, setTags] = useState<string[]>([...saved]);
  const [known, setKnown] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => { setTags([...saved]); }, [saved]);
  // The known tags are reloaded after every save of this field (savedKey changes), so a new tag is offered at once.
  useEffect(() => {
    let cancelled = false;
    read.listTags()
      .then((list) => { if (!cancelled) setKnown(list.map((entry) => entry.tag)); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load the tags."); });
    return () => { cancelled = true; };
  }, [savedKey]);
  return (
    <div className="grid gap-1.5">
      <TagInput label="Tags" value={tags} onChange={setTags} suggestions={known} isDisabled={editor.saving === "tags"}
        onCommit={(next) => { if (next.join("\n") !== savedKey) void editor.save({ tags: next }); }} />
      {error ?? editor.errors.tags ? <p role="alert" className="m-0 text-[12px] text-red">{error ?? editor.errors.tags}</p> : null}
      <ExtractedLine editor={editor} field="tags" />
    </div>
  );
}

/**
 * The Info inspector, Zotero-style: the type decides the fields; every field saves on its own
 * (blur or Enter) through updateMaterialMeta and shows what was extracted when it differs. `onSaved`
 * hands the updated record back so the header, the reader body and the Library row follow at once.
 */
export function InfoPanel({ material, views, onSaved, onOpenLink, onOpenMaterial, onReport, onRebuild, rebuild = "idle", rebuildError }: { material: MaterialRecord; views?: MaterialViewController | undefined; onSaved: (record: MaterialRecord) => void; onOpenLink: (url: string) => void; onOpenMaterial: (id: string) => void; onReport?: (() => void) | undefined } & Partial<RebuildProps>) {
  const editor = useMaterialMeta(material, onSaved);
  const kind = editor.meta.kind ?? "webpage";
  return (
    <>
      <InspectorSection title="Details">
        <div className="grid gap-3">
          <KindField editor={editor} />
          <MetaTextField editor={editor} field="title" />
          <MetaTextField editor={editor} field="shortTitle" />
          <InfoCreators key={material.id} editor={editor} />
          <MetaTextField editor={editor} field="abstract" multiline />
          <InfoFields editor={editor} kind={kind} />
          <InfoIdentifiers editor={editor} kind={kind} onOpenLink={onOpenLink} />
          <TagsField editor={editor} />
          <InfoRelated editor={editor} selfId={material.id} onOpenMaterial={onOpenMaterial} />
          <MetaTextField editor={editor} field="note" multiline />
          <MetaTextField editor={editor} field="extra" multiline />
        </div>
      </InspectorSection>
      <InfoActions material={material} onSaved={onSaved} />
      <InfoFacts material={material} views={views} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onReport={onReport} onRebuild={onRebuild} rebuild={rebuild} rebuildError={rebuildError} />
    </>
  );
}
