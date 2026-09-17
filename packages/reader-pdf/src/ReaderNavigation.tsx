import {
  useCallback,
  useId,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

export type ReaderNavigationProps<T extends string> = Readonly<{
  activeView: T;
  children: (view: T) => ReactNode;
  label: string;
  onSelect: (view: T) => void;
  scrollClassName?: string;
  scrollRef?: Ref<HTMLDivElement>;
  views: readonly { id: T; label: string }[];
}>;

function nextIndexForKey(key: string, current: number, count: number) {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

/**
 * Shared navigation chrome following the WAI-ARIA tabs pattern with automatic
 * activation: one roving tab stop, arrow keys move focus and selection
 * together, Home/End jump to the ends. Format adapters supply the views, never
 * the surrounding navigation behaviour.
 */
export function ReaderNavigation<T extends string>({
  activeView,
  children,
  label,
  onSelect,
  scrollClassName = "",
  scrollRef,
  views,
}: ReaderNavigationProps<T>) {
  const baseId = useId();
  const tabRefs = useRef(new Map<T, HTMLButtonElement>());
  const tabId = (view: T) => `${baseId}-tab-${view}`;
  const panelId = (view: T) => `${baseId}-panel-${view}`;

  const focusTab = useCallback(
    (view: T) => tabRefs.current.get(view)?.focus(),
    [],
  );

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, view: T) => {
    const current = views.findIndex((candidate) => candidate.id === view);
    const next = nextIndexForKey(event.key, current, views.length);
    if (next === undefined) return;
    event.preventDefault();
    const target = views[next];
    if (target) focusTab(target.id);
  };

  // The tablist is programmatically focusable so hosts can hand focus to the
  // group; it forwards straight to the active tab and is never a Tab stop.
  const forwardListFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    focusTab(activeView);
  };

  return (
    <div className="reader-navigation">
      <div
        aria-label={label}
        className="reader-navigation-tabs"
        onFocus={forwardListFocus}
        role="tablist"
        tabIndex={-1}
      >
        {views.map((view) => {
          const selected = view.id === activeView;
          return (
            <button
              aria-controls={panelId(view.id)}
              aria-selected={selected}
              className="reader-navigation-tab"
              data-state={selected ? "active" : "inactive"}
              id={tabId(view.id)}
              key={view.id}
              onClick={() => onSelect(view.id)}
              onFocus={() => {
                if (!selected) onSelect(view.id);
              }}
              onKeyDown={(event) => handleTabKeyDown(event, view.id)}
              ref={(element) => {
                if (element) tabRefs.current.set(view.id, element);
                else tabRefs.current.delete(view.id);
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {view.label}
            </button>
          );
        })}
      </div>
      <div className={`reader-navigation-scroll ${scrollClassName}`} ref={scrollRef}>
        <div
          aria-labelledby={tabId(activeView)}
          className="reader-navigation-panel"
          id={panelId(activeView)}
          role="tabpanel"
          tabIndex={0}
        >
          {children(activeView)}
        </div>
      </div>
    </div>
  );
}
