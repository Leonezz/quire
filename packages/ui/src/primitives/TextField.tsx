import { Input, Label, TextArea, TextField as AriaTextField, Text, composeRenderProps, type TextFieldProps as AriaTextFieldProps } from "react-aria-components";
import { useShake } from "./Motion";
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
  // A new error shakes the field once; the message itself rises in.
  const inputRef = useShake<HTMLInputElement & HTMLTextAreaElement>(errorMessage);
  return (
    <AriaTextField {...props} className={composeRenderProps(className, (cls) => cx("group flex flex-col gap-1.5", cls))}>
      {label ? <Label className="text-[12.5px] font-medium text-label-2">{label}</Label> : null}
      {multiline ? (
        <TextArea
          {...(placeholder !== undefined ? { placeholder } : {})}
          ref={inputRef}
          rows={1}
          className={cx(inputClass, "t-shake min-h-9 resize-none py-2 text-[13.5px] leading-[19px] [field-sizing:content]")}
          style={{ maxHeight: `${maxRows * 19 + 16}px` }}
        />
      ) : (
        <Input ref={inputRef} {...(placeholder !== undefined ? { placeholder } : {})} className={cx(inputClass, "t-shake h-9 text-[15px]")} />
      )}
      {description ? <Text key={description} slot="description" className="t-text-in text-[11.5px] text-label-3">{description}</Text> : null}
      {errorMessage ? <Text key={errorMessage} slot="errorMessage" className="t-text-in text-[12px] text-red">{errorMessage}</Text> : null}
    </AriaTextField>
  );
}
