import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import { SplitGroup, SplitPanel, SplitSeparator, useSplitPanelRef, useSplitSizes } from "../primitives/SplitPane";
import { Button } from "../primitives/Button";

const meta = { title: "Primitives/SplitPane", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Pane({ label }: { label: string }) {
  return <div className="grid h-full place-items-center rounded-panel bg-content text-[13px] text-label-2 shadow-[0_0_0_1px_var(--separator-soft)]">{label}</div>;
}

function Shell() {
  const sidebar = useSplitPanelRef();
  const [collapsed, setCollapsed] = useState(false);
  const shell = useSplitSizes("story-shell");
  const inner = useSplitSizes("story-list");
  return (
    <div className="m-6 h-[420px] w-[960px] rounded-window bg-ground p-3 shadow-window">
      <div className="mb-2 flex gap-2">
        <Button size="sm" onPress={() => { if (sidebar.current?.isCollapsed()) sidebar.current.expand(); else sidebar.current?.collapse(); }}>{collapsed ? "Show sidebar" : "Hide sidebar"}</Button>
      </div>
      <SplitGroup id="story-shell" aria-label="Shell" className="h-[360px] gap-3">
        <SplitPanel id="sidebar" panelRef={sidebar} defaultSize={shell.sizeOf("sidebar", 236)} minSize={180} maxSize={320} collapsible collapsedSize={0} onResize={(size, id, previous) => { setCollapsed(size.inPixels === 0); shell.onResize("sidebar")(size, id, previous); }}>
          <Pane label="Sidebar" />
        </SplitPanel>
        <SplitSeparator aria-label="Resize sidebar" hit={12} footprint={12} line="hover" />
        <SplitPanel id="main" minSize={320}>
          <SplitGroup id="story-list" aria-label="List and detail" className="h-full rounded-panel bg-content shadow-[0_0_0_1px_var(--separator-soft)]">
            <SplitPanel id="list" defaultSize={inner.sizeOf("list", 320)} minSize={240} maxSize={480} onResize={inner.onResize("list")}><div className="grid h-full place-items-center text-[13px] text-label-2">List</div></SplitPanel>
            <SplitSeparator aria-label="Resize list" />
            <SplitPanel id="detail" minSize={240}><div className="grid h-full place-items-center text-[13px] text-label-2">Detail</div></SplitPanel>
          </SplitGroup>
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

export const Resizable: Story = {
  render: () => <Shell />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const separator = canvas.getByRole("separator", { name: "Resize sidebar" });
    const before = Number(separator.getAttribute("aria-valuenow"));
    // Keyboard: the separator is focusable and the arrow keys move it.
    separator.focus();
    await expect(separator).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
    await userEvent.keyboard("{ArrowLeft}");
    // Collapsing from the button: the sidebar folds to zero and the button reflects it.
    await userEvent.click(canvas.getByRole("button", { name: "Hide sidebar" }));
    await expect(await canvas.findByRole("button", { name: "Show sidebar" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Show sidebar" }));
    await expect(await canvas.findByRole("button", { name: "Hide sidebar" })).toBeVisible();
    // The inner split has its own labelled separator.
    await expect(canvas.getByRole("separator", { name: "Resize list" })).toBeInTheDocument();
  },
};
