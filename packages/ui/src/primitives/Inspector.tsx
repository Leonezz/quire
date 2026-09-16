import { Tab, TabList, TabPanel, Tabs, composeRenderProps, type TabPanelProps, type TabProps, type TabsProps } from "react-aria-components";
import { cx } from "../cx";

/** Floating glass inspector; tabs are a capsule segmented control. */
export function Inspector({ className, ...props }: TabsProps) {
  return (
    <Tabs
      {...props}
      className={composeRenderProps(className, (cls) => cx("glass grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-panel", cls))}
    />
  );
}

export function InspectorTabs({ children, className }: { children: React.ReactNode; className?: string }) {
  return <TabList className={cx("mx-3 mb-1 mt-3 flex items-center gap-0.5 rounded-pill bg-fill p-[3px]", className)}>{children}</TabList>;
}

export function InspectorTab({ className, ...props }: TabProps) {
  return (
    <Tab
      {...props}
      className={composeRenderProps(className, (cls) => cx(
        "flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-pill px-2 text-[12.5px] font-medium leading-4 text-label-2 outline-none [&>svg]:size-3.5",
        "data-[selected]:bg-content data-[selected]:text-label data-[selected]:shadow-[0_1px_3px_rgba(15,17,21,.10)] data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring",
        cls,
      ))}
    />
  );
}

export function InspectorPanel({ className, ...props }: TabPanelProps) {
  return <TabPanel {...props} className={composeRenderProps(className, (cls) => cx("flex min-h-0 flex-col gap-4 overflow-auto px-4 pb-4 pt-3 outline-none", cls))} />;
}

export function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.07em] text-label-3">{title}</h3>
      {children}
    </section>
  );
}
