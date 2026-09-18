import { Button, Group, Input, Label, NumberField as AriaNumberField, Text, composeRenderProps, type NumberFieldProps as AriaNumberFieldProps } from "react-aria-components";
import { Minus, Plus } from "lucide-react";
import { cx } from "../cx";

export interface NumberFieldProps extends AriaNumberFieldProps {
  label?: string | undefined;
  description?: string | undefined;
  errorMessage?: string | undefined;
  /** A unit shown after the value ("min"). */
  unit?: string | undefined;
}

/** A whole number with − / + steppers; ↑/↓ step, typing is validated against min and max by the caller. */
export function NumberField({ label, description, errorMessage, unit, className, ...props }: NumberFieldProps) {
  return (
    <AriaNumberField {...props} isInvalid={props.isInvalid ?? errorMessage !== undefined} className={composeRenderProps(className, (cls) => cx("group flex flex-col gap-1.5", cls))}>
      {label ? <Label className="text-[12.5px] font-medium text-label-2">{label}</Label> : null}
      <Group className="flex h-9 w-fit items-center rounded-control bg-fill data-[focus-within]:bg-content data-[focus-within]:shadow-[0_0_0_1px_var(--separator),0_0_0_4px_var(--accent-soft)] group-data-[invalid]:shadow-[0_0_0_1px_var(--red)]">
        <Button slot="decrement" aria-label="Decrease" className="grid h-full w-8 cursor-default place-items-center rounded-l-control text-label-2 outline-none data-[hovered]:bg-fill data-[disabled]:opacity-40 data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring"><Minus className="size-3.5" /></Button>
        <Input className="h-full w-[72px] bg-transparent text-center text-[14px] tabular-nums text-label outline-none" />
        {unit ? <span className="pr-1 text-[12px] text-label-3">{unit}</span> : null}
        <Button slot="increment" aria-label="Increase" className="grid h-full w-8 cursor-default place-items-center rounded-r-control text-label-2 outline-none data-[hovered]:bg-fill data-[disabled]:opacity-40 data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring"><Plus className="size-3.5" /></Button>
      </Group>
      {description ? <Text slot="description" className="text-[11.5px] text-label-3">{description}</Text> : null}
      {errorMessage ? <Text slot="errorMessage" role="alert" className="text-[12px] text-red-text">{errorMessage}</Text> : null}
    </AriaNumberField>
  );
}
