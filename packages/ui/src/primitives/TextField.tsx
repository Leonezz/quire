import { Input, Label, TextField as AriaTextField, Text, composeRenderProps, type TextFieldProps as AriaTextFieldProps } from "react-aria-components";
import { cx } from "../cx";

export interface TextFieldProps extends AriaTextFieldProps {
  label?: string;
  placeholder?: string;
  description?: string;
  errorMessage?: string;
}

export function TextField({ label, placeholder, description, errorMessage, className, ...props }: TextFieldProps) {
  return (
    <AriaTextField {...props} className={composeRenderProps(className, (cls) => cx("group flex flex-col gap-1.5", cls))}>
      {label ? <Label className="text-[12.5px] font-medium text-label-2">{label}</Label> : null}
      <Input
        {...(placeholder !== undefined ? { placeholder } : {})}
        className="h-9 rounded-control bg-fill px-3 text-[15px] text-label outline-none placeholder:text-label-3 data-[focused]:bg-content data-[focused]:shadow-[0_0_0_1px_var(--separator),0_0_0_4px_var(--accent-soft)] group-data-[invalid]:shadow-[0_0_0_1px_var(--red)]"
      />
      {description ? <Text slot="description" className="text-[11.5px] text-label-3">{description}</Text> : null}
      {errorMessage ? <Text slot="errorMessage" className="text-[12px] text-red">{errorMessage}</Text> : null}
    </AriaTextField>
  );
}
