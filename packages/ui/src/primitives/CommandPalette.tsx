import { Autocomplete, Dialog, Input, ListBox, ListBoxItem, Modal, ModalOverlay, SearchField, type Key } from "react-aria-components";
import { cx } from "../cx";

export interface CommandPaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  /** A short kind label shown as a pill before the title ("material", "item"). */
  kind?: string;
}

export interface CommandPaletteProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  "aria-label": string;
  placeholder?: string;
  /** Controlled query: the owner debounces and runs the search. */
  query: string;
  onQueryChange: (query: string) => void;
  items: CommandPaletteItem[];
  onSelect: (id: string) => void;
  /** A line under the field: "Searching…", an error, or a hint. */
  status?: string | undefined;
  /** Whether `status` is an error (rendered in red and announced). */
  statusIsError?: boolean;
  /** Shown in the list area when the query is non-empty and there are no items. */
  emptyText?: string;
}

/**
 * ⌘K search: a field on top of a results list. Focus stays in the field; the list has virtual
 * focus (↑/↓ move, Enter selects, Escape closes) — all from Autocomplete + ListBox.
 */
export function CommandPalette({ isOpen, onOpenChange, placeholder, query, onQueryChange, items, onSelect, status, statusIsError = false, emptyText = "No matches.", ...props }: CommandPaletteProps) {
  const label = props["aria-label"];
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className="fixed inset-0 z-40 grid place-items-start justify-center bg-[rgba(15,17,21,.26)] pt-[12vh] backdrop-blur-[6px] entering:animate-[fade_.15s_ease] exiting:animate-[fade_.12s_ease_reverse]">
      <Modal className="w-[600px] max-w-[92vw] overflow-hidden rounded-[22px] bg-content shadow-float outline-none">
        <Dialog aria-label={label} className="flex max-h-[60vh] flex-col outline-none">
          <Autocomplete inputValue={query} onInputChange={onQueryChange}>
            <SearchField aria-label={label} autoFocus className="group flex h-[52px] items-center gap-2 border-b border-separator-soft px-4 text-[16px] text-label">
              <Input {...(placeholder !== undefined ? { placeholder } : {})} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-label-3 [&::-webkit-search-cancel-button]:hidden" />
              <kbd className="rounded-control bg-fill px-1.5 py-0.5 font-sans text-[11px] font-medium text-label-3">esc</kbd>
            </SearchField>
            {status ? <p role={statusIsError ? "alert" : "status"} className={cx("px-4 pt-2.5 text-[12px]", statusIsError ? "text-red" : "text-label-3")}>{status}</p> : null}
            <ListBox
              aria-label="Results"
              items={items}
              selectionMode="none"
              onAction={(key: Key) => onSelect(String(key))}
              renderEmptyState={() => (query.trim() ? <p className="px-4 py-6 text-center text-[13px] text-label-3">{emptyText}</p> : null)}
              className="flex flex-col gap-px overflow-y-auto p-2 outline-none"
            >
              {(item) => (
                <ListBoxItem
                  id={item.id}
                  textValue={item.title}
                  className="grid cursor-default grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5 rounded-xl px-3 py-2 outline-none data-[focused]:bg-accent-soft data-[hovered]:bg-fill"
                >
                  <span className={cx("whitespace-nowrap rounded-pill px-[7px] py-px text-[10.5px] font-medium leading-[14px]", item.kind ? "bg-fill text-label-2" : "hidden")}>{item.kind}</span>
                  <span className="grid min-w-0">
                    <span className="truncate text-[14px] font-medium leading-5 text-label">{item.title}</span>
                    {item.subtitle ? <span className="truncate text-[12px] leading-[16px] text-label-2">{item.subtitle}</span> : null}
                  </span>
                </ListBoxItem>
              )}
            </ListBox>
          </Autocomplete>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
