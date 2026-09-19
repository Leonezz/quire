import { ChevronDown } from "lucide-react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { Menu, MenuItem, MenuTrigger } from "./Menu";
import { cx } from "../cx";

export interface MenuSelectOption {
  id: string;
  label: string;
  /** Shown muted after the label (a count of matching rows). */
  count?: number | undefined;
  isDisabled?: boolean | undefined;
}

export interface MenuSelectProps {
  "aria-label": string;
  value: string;
  options: readonly MenuSelectOption[];
  onChange: (id: string) => void;
  /** Before the label in the trigger. */
  icon?: React.ReactNode;
  size?: ButtonSize;
  variant?: ButtonVariant;
  isDisabled?: boolean | undefined;
  className?: string | undefined;
  /** The trigger's label when `value` matches no option. */
  placeholder?: string;
}

/**
 * A single-choice popup: a button that reads the current option and opens a menu of all of them.
 * Space / Enter / ↓ open it, ↑ / ↓ move, Enter picks, Esc closes — all from MenuTrigger.
 */
export function MenuSelect({ value, options, onChange, icon, size = "sm", variant = "quiet", isDisabled = false, className, placeholder = "Choose…", ...props }: MenuSelectProps) {
  const current = options.find((option) => option.id === value);
  return (
    <MenuTrigger>
      <Button size={size} variant={variant} isDisabled={isDisabled} aria-label={`${props["aria-label"]}: ${current?.label ?? placeholder}`} className={cx("min-w-0 gap-1", className)}>
        {icon}
        <span className="truncate">{current?.label ?? placeholder}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </Button>
      <Menu aria-label={props["aria-label"]} selectionMode="single" disallowEmptySelection selectedKeys={[value]}
        onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; if (key !== undefined && String(key) !== value) onChange(String(key)); }}>
        {options.map((option) => (
          <MenuItem key={option.id} id={option.id} textValue={option.label} isDisabled={option.isDisabled ?? false}>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.count !== undefined ? <span className="text-[11.5px] tabular-nums opacity-60">{option.count}</span> : null}
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );
}
