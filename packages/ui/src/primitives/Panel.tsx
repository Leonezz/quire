import { X } from "lucide-react";
import { Button } from "react-aria-components";
import { cx } from "../cx";

export interface PanelProps {
  /** The panel's name, the only thing in its header: "Info", "Notes", "Agent". */
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string | undefined;
  "aria-label"?: string | undefined;
}

/**
 * The one side panel: a 40px header with the name and ×, then the body. Which panel shows is
 * decided by the toolbar (Info / Notes / Ask), never by tabs here; Esc closes it from the owner.
 */
export function Panel({ title, onClose, children, className, "aria-label": ariaLabel }: PanelProps) {
  return (
    <aside aria-label={ariaLabel ?? title} className={cx("panel-slide grid h-full min-h-0 grid-rows-[40px_minmax(0,1fr)] bg-content", className)}>
      <header className="flex items-center gap-2 border-b border-separator pl-4 pr-2">
        <h2 className="m-0 min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 text-label">{title}</h2>
        <Button aria-label={`Close ${title}`} onPress={onClose} className="grid size-7 place-items-center rounded-control text-label-3 outline-none transition-colors duration-100 data-[hovered]:bg-fill data-[hovered]:text-label data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring [&>svg:not(.icon)]:size-icon-md"><X /></Button>
      </header>
      <div className="flex min-h-0 flex-col gap-4 overflow-auto px-4 pb-4 pt-3">{children}</div>
    </aside>
  );
}

export function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.07em] text-label-3">{title}</h3>
      {children}
    </section>
  );
}
