import { Input, Label, TextArea, TextField as AriaTextField, Text, composeRenderProps, type TextFieldProps as AriaTextFieldProps } from "react-aria-components";
import { cx } from "../cx";

export interface TextFieldProps extends AriaTextFieldProps {
  label?: string;
  placeholder?: string;
  description?: string;
  errorMessage?: string;
  /** A textarea that grows with its content (up to `maxRows` lines) instead of a single-line input. */
  multiline?: boolean;
  maxRows?: number;
}

const inputClass = "rounded-control bg-fill px-3 text-label outline-none placeholder:text-label-3 data-[focused]:bg-content data-[focused]:shadow-[0_0_0_1px_var(--separator),0_0_0_4px_var(--accent-soft)] group-data-[invalid]:shadow-[0_0_0_1px_var(--red)]";

export function TextField({ label, placeholder, description, errorMessage, multiline = false, maxRows = 6, className, ...props }: TextFieldProps) {
  return (
    <AriaTextField {...props} className={composeRenderProps(className, (cls) => cx("group flex flex-col gap-1.5", cls))}>
      {label ? <Label className="text-[12.5px] font-medium text-label-2">{label}</Label> : null}
      {multiline ? (
        <TextArea
          {...(placeholder !== undefined ? { placeholder } : {})}
          rows={1}
          className={cx(inputClass, "min-h-9 resize-none py-2 text-[13.5px] leading-[19px] [field-sizing:content]")}
          style={{ maxHeight: `${maxRows * 19 + 16}px` }}
        />
      ) : (
        <Input {...(placeholder !== undefined ? { placeholder } : {})} className={cx(inputClass, "h-9 text-[15px]")} />
      )}
      {description ? <Text slot="description" className="text-[11.5px] text-label-3">{description}</Text> : null}
      {errorMessage ? <Text slot="errorMessage" className="text-[12px] text-red">{errorMessage}</Text> : null}
    </AriaTextField>
  );
}
