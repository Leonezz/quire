import { useEffect, useState } from "react";
import { Button, CreatorRow } from "@read/ui";
import type { Creator, CreatorRole } from "../../shared/contracts";
import { CREATOR_ROLES, ROLE_LABELS, isCreatorRole } from "./materialMeta";
import { ExtractedLine } from "./InfoFields";
import type { MaterialMetaEditor } from "./useMaterialMeta";

const roleOptions = CREATOR_ROLES.map((role) => ({ id: role, label: ROLE_LABELS[role] }));
/** One shared empty list: a fresh `[]` per render would retrigger the sync effect forever. */
const NO_CREATORS: readonly Creator[] = [];
const sameList = (a: readonly Creator[], b: readonly Creator[]) => JSON.stringify(a) === JSON.stringify(b);
const swap = (list: Creator[], a: number, b: number) => list.map((item, at) => (at === a ? list[b]! : at === b ? list[a]! : item));

/** A structured creator keeps `given` / `family` until its text changes; then the engine re-parses "Family, Given". */
function renamed(creator: Creator, name: string): Creator {
  if (name === creator.name) return creator;
  return { role: creator.role, name };
}

/**
 * The creators editor: rows of [role][name][↑][↓][×] and "+ Add creator". Reorder, remove and
 * role changes save at once; a name saves on Enter or blur. Rows without a name are not sent.
 */
export function InfoCreators({ editor }: { editor: MaterialMetaEditor }) {
  const saved = editor.meta.creators ?? NO_CREATORS;
  const [rows, setRows] = useState<Creator[]>([...saved]);
  const [focusLast, setFocusLast] = useState(false);
  useEffect(() => { setRows([...saved]); }, [saved]);

  const commit = (next: Creator[]) => {
    const named = next.filter((creator) => creator.name.trim());
    if (sameList(named, saved)) return;
    void editor.save({ creators: named });
  };
  const update = (next: Creator[], save: boolean) => { setRows(next); if (save) commit(next); };
  const disabled = editor.saving === "creators";

  return (
    <div className="grid gap-1.5">
      <span className="text-[12.5px] font-medium text-label-2">Creators</span>
      {rows.map((creator, index) => (
        <CreatorRow key={index} index={index} count={rows.length} role={creator.role} roles={roleOptions} name={creator.name} isDisabled={disabled}
          autoFocus={focusLast && index === rows.length - 1}
          onRoleChange={(role) => { if (isCreatorRole(role)) update(rows.map((item, at) => (at === index ? { ...item, role: role as CreatorRole } : item)), true); }}
          onNameChange={(name) => update(rows.map((item, at) => (at === index ? renamed(item, name) : item)), false)}
          onNameCommit={() => commit(rows)}
          onMoveUp={() => update(swap(rows, index, index - 1), true)}
          onMoveDown={() => update(swap(rows, index, index + 1), true)}
          onRemove={() => update(rows.filter((_, at) => at !== index), true)} />
      ))}
      <Button size="sm" variant="plain" className="justify-self-start" isDisabled={disabled} onPress={() => { setFocusLast(true); setRows((list) => [...list, { role: "author", name: "" }]); }}>+ Add creator</Button>
      {editor.errors.creators ? <p role="alert" className="m-0 text-[12px] text-red">{editor.errors.creators}</p> : null}
      <ExtractedLine editor={editor} field="creators" />
    </div>
  );
}
