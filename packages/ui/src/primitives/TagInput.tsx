import { useId, useRef, useState } from "react";
import { Button as AriaButton, Input, Label, ListBox, ListBoxItem, Popover } from "react-aria-components";
import { X } from "lucide-react";
import { cx } from "../cx";

export type ChipTone = "neutral" | "accent";

/** A small label: a tag on a row, a state on a card. `onRemove` adds an × that removes it. */
export function Chip({ children, tone = "neutral", onRemove, removeLabel, className }: { children: React.ReactNode; tone?: ChipTone; onRemove?: (() => void) | undefined; removeLabel?: string | undefined; className?: string | undefined }) {
  return (
    <span className={cx(
      "inline-flex h-[20px] max-w-full items-center gap-0.5 whitespace-nowrap rounded-pill pl-2 text-[11.5px] font-medium leading-[14px]",
      onRemove ? "pr-0.5" : "pr-2",
      tone === "accent" ? "bg-accent-soft text-accent-text" : "bg-fill text-label-2",
      className,
    )}>
      <span className="truncate">{children}</span>
      {onRemove ? (
        <AriaButton aria-label={removeLabel ?? `Remove ${String(children)}`} onPress={onRemove} className="grid size-4 shrink-0 cursor-default place-items-center rounded-full text-current outline-none data-[hovered]:bg-fill-2 data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent-ring">
          <X className="size-3" />
        </AriaButton>
      ) : null}
    </span>
  );
}

export interface TagInputProps {
  label?: string | undefined;
  "aria-label"?: string | undefined;
  value: readonly string[];
  onChange: (tags: string[]) => void;
  /** Known tags offered while typing (matched case-insensitively; the ones already chosen are hidden). */
  suggestions?: readonly string[] | undefined;
  placeholder?: string | undefined;
  /** Called once a change is meant to be saved: after a tag was added or removed, and when the field loses focus. */
  onCommit?: ((tags: string[]) => void) | undefined;
  isDisabled?: boolean | undefined;
  className?: string | undefined;
}

function normalized(tag: string): string { return tag.trim(); }
function includes(tags: readonly string[], tag: string): boolean { return tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase()); }

/**
 * Chips plus a text field. Enter (or a comma) adds what was typed, Backspace on an empty field
 * removes the last chip, × removes any chip. While typing, matching suggestions open below;
 * ↓ moves into them and Enter picks one.
 */
export function TagInput({ label, value, onChange, suggestions = [], placeholder = "Add a tag…", onCommit, isDisabled = false, className, ...props }: TagInputProps) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const listId = useId();
  const query = normalized(draft).toLowerCase();
  const matches = query ? suggestions.filter((tag) => tag.toLowerCase().includes(query) && !includes(value, tag)).slice(0, 8) : [];
  const open = focused && matches.length > 0;

  const commit = (tags: string[]) => { onChange(tags); onCommit?.(tags); };
  const add = (raw: string) => {
    const tag = normalized(raw);
    if (!tag) return;
    setDraft("");
    if (includes(value, tag)) return;
    commit([...value, tag]);
  };
  const removeAt = (index: number) => { commit(value.filter((_, at) => at !== index)); inputRef.current?.focus(); };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" || event.key === ",") { event.preventDefault(); add(draft); return; }
    if (event.key === "Escape" && draft) { event.stopPropagation(); setDraft(""); return; }
    if (event.key === "Backspace" && draft === "" && value.length > 0) { event.preventDefault(); removeAt(value.length - 1); return; }
    if (event.key === "ArrowDown" && open) {
      event.preventDefault();
      rootRef.current?.ownerDocument.querySelector<HTMLElement>(`#${CSS.escape(listId)} [role="option"]`)?.focus();
    }
  };
  const onBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (rootRef.current?.contains(next) || next.closest?.(`#${CSS.escape(listId)}`))) return;
    setFocused(false);
    if (normalized(draft)) add(draft); else onCommit?.([...value]);
  };

  return (
    <div ref={rootRef} className={cx("group flex flex-col gap-1.5", className)} onFocus={() => setFocused(true)} onBlur={onBlur}>
      {label ? <Label id={labelId} className="text-[12.5px] font-medium text-label-2" onClick={() => inputRef.current?.focus()}>{label}</Label> : null}
      <div className={cx("flex min-h-9 flex-wrap items-center gap-1 rounded-control bg-fill px-2 py-1 transition-shadow", "has-[input:focus]:bg-content has-[input:focus]:shadow-[0_0_0_1px_var(--separator),0_0_0_4px_var(--accent-soft)]", isDisabled && "opacity-45")}>
        {value.map((tag, index) => <Chip key={tag} onRemove={isDisabled ? undefined : () => removeAt(index)} removeLabel={`Remove ${tag}`}>{tag}</Chip>)}
        <Input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={value.length ? "" : placeholder}
          disabled={isDisabled}
          aria-label={props["aria-label"] ?? label ?? "Tags"}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          {...(open ? { "aria-controls": listId } : {})}
          className="h-7 min-w-[80px] flex-1 bg-transparent px-1 text-[13.5px] text-label outline-none placeholder:text-label-3"
        />
      </div>
      <Popover isOpen={open} onOpenChange={(next) => { if (!next) setFocused(false); }} triggerRef={rootRef} placement="bottom start" offset={4} isNonModal shouldFlip className="glass-strong min-w-[200px] rounded-card p-1.5 outline-none">
        <ListBox id={listId} aria-label="Suggested tags" items={matches.map((tag) => ({ id: tag }))} selectionMode="none" onAction={(key) => { add(String(key)); inputRef.current?.focus(); }}
          onBlur={(event) => { if (!(event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget))) setFocused(false); }}
          className="outline-none">
          {(item) => <ListBoxItem id={item.id} textValue={item.id} className="cursor-default rounded-control px-2.5 py-1.5 text-[13px] text-label outline-none data-[focused]:bg-accent data-[focused]:text-on-accent data-[hovered]:bg-fill">{item.id}</ListBoxItem>}
        </ListBox>
      </Popover>
    </div>
  );
}
