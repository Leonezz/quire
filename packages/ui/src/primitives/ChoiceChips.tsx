import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { Check } from "lucide-react";
import { Icon } from "./Icon";
import { cx } from "../cx";

export interface ChoiceChipOption {
  id: string;
  label: string;
  isDisabled?: boolean | undefined;
}

export interface ChoiceChipsProps {
  "aria-label"?: string | undefined;
  "aria-labelledby"?: string | undefined;
  options: readonly ChoiceChipOption[];
  /** The chosen ids; `onChange` hands back the new set in option order. */
  value: readonly string[];
  onChange: (ids: string[]) => void;
  isDisabled?: boolean | undefined;
  className?: string | undefined;
}

/**
 * Toggle chips for a multiple choice: each option is a pill that reads as pressed when chosen.
 * ← / → move between chips, Space or Enter toggles the focused one — from ToggleButtonGroup (a `toolbar` role when several can be chosen).
 */
export function ChoiceChips({ options, value, onChange, isDisabled = false, className, ...props }: ChoiceChipsProps) {
  const labels = { ...(props["aria-label"] !== undefined ? { "aria-label": props["aria-label"] } : {}), ...(props["aria-labelledby"] !== undefined ? { "aria-labelledby": props["aria-labelledby"] } : {}) };
  return (
    <ToggleButtonGroup
      {...labels}
      selectionMode="multiple"
      selectedKeys={value as string[]}
      isDisabled={isDisabled}
      onSelectionChange={(keys) => onChange(options.map((option) => option.id).filter((id) => keys.has(id)))}
      className={cx("flex flex-wrap gap-1.5", className)}
    >
      {options.map((option) => (
        <ToggleButton
          key={option.id}
          id={option.id}
          isDisabled={option.isDisabled ?? false}
          className={cx(
            "inline-flex h-7 cursor-default select-none items-center gap-1 rounded-pill bg-fill px-3 text-[12.5px] font-medium leading-4 text-label-2 outline-none transition-colors duration-100",
            "data-[hovered]:bg-fill-2 data-[hovered]:text-label data-[selected]:bg-accent-soft data-[selected]:text-accent-text",
            "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring data-[disabled]:opacity-45",
          )}
        >
          {({ isSelected }) => (
            <>
              {isSelected ? <Icon of={Check} size="sm" /> : null}
              {option.label}
            </>
          )}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
