import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Button as AriaButton, Input, TextField } from "react-aria-components";
import { MenuSelect, type MenuSelectOption } from "./MenuSelect";
import { cx } from "../cx";

export interface CreatorRowProps {
  /** 0-based position, for the accessible names and the disabled state of ↑ / ↓. */
  index: number;
  count: number;
  role: string;
  roles: readonly MenuSelectOption[];
  name: string;
  onRoleChange: (role: string) => void;
  onNameChange: (name: string) => void;
  /** The name is meant to be saved: Enter in the field, or the field lost focus. */
  onNameCommit: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  placeholder?: string | undefined;
  isDisabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
}

const iconButton = "grid size-7 shrink-0 cursor-default place-items-center rounded-control text-label-2 outline-none data-[hovered]:bg-fill data-[hovered]:text-label data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring data-[disabled]:opacity-30 [&>svg:not(.icon)]:size-icon-md";

/**
 * One creator of a material: [role][name][↑][↓][×]. Every control is in the tab order; inside
 * the name field ⌥↑ / ⌥↓ move the row and Enter commits the name.
 */
export function CreatorRow({ index, count, role, roles, name, onRoleChange, onNameChange, onNameCommit, onMoveUp, onMoveDown, onRemove, placeholder = "Family, Given", isDisabled = false, autoFocus = false, className }: CreatorRowProps) {
  const who = name.trim() || `creator ${index + 1}`;
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); return; }
    if (event.altKey && event.key === "ArrowUp" && index > 0) { event.preventDefault(); onMoveUp(); return; }
    if (event.altKey && event.key === "ArrowDown" && index < count - 1) { event.preventDefault(); onMoveDown(); }
  };
  return (
    <div role="group" aria-label={`Creator ${index + 1} of ${count}`} className={cx("grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-1", className)}>
      <MenuSelect aria-label={`Role of ${who}`} value={role} options={roles} onChange={onRoleChange} isDisabled={isDisabled} className="h-8 px-2 text-[12.5px]" />
      <TextField aria-label={`Name of creator ${index + 1}`} value={name} onChange={onNameChange} isDisabled={isDisabled} autoFocus={autoFocus} className="group min-w-0">
        <Input placeholder={placeholder} onKeyDown={onKeyDown} onBlur={onNameCommit}
          className="h-8 w-full rounded-control bg-fill px-2.5 text-[13.5px] text-label outline-none placeholder:text-label-3 data-[focused]:bg-content data-[focused]:shadow-[0_0_0_1px_var(--separator),0_0_0_4px_var(--accent-soft)]" />
      </TextField>
      <AriaButton aria-label={`Move ${who} up`} isDisabled={isDisabled || index === 0} onPress={onMoveUp} className={iconButton}><ArrowUp /></AriaButton>
      <AriaButton aria-label={`Move ${who} down`} isDisabled={isDisabled || index >= count - 1} onPress={onMoveDown} className={iconButton}><ArrowDown /></AriaButton>
      <AriaButton aria-label={`Remove ${who}`} isDisabled={isDisabled} onPress={onRemove} className={iconButton}><X /></AriaButton>
    </div>
  );
}
