import { Input, SearchField, composeRenderProps, type SearchFieldProps } from "react-aria-components";
import { cx } from "../cx";

/** Search / filter field. Esc clears, then blurs — SearchField handles both. */
export function Search({ className, placeholder, ...props }: SearchFieldProps & { placeholder?: string }) {
  return (
    <SearchField {...props} className={composeRenderProps(className, (cls) => cx("group flex h-9 items-center gap-2 rounded-control bg-fill px-3 text-[15px] text-label data-[focus-within]:bg-content data-[focus-within]:shadow-[0_0_0_1px_var(--separator),0_0_0_4px_var(--accent-soft)]", cls))}>
      <Input {...(placeholder !== undefined ? { placeholder } : {})} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-label-3 [&::-webkit-search-cancel-button]:hidden" />
    </SearchField>
  );
}
