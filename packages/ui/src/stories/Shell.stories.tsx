import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useState } from "react";
import { Highlighter, Info, List, PanelLeft, Plus, Search as SearchIcon, Sparkles, Type } from "lucide-react";
import { AskButton, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle } from "../primitives/Toolbar";
import { Panel, InspectorSection } from "../primitives/Panel";
import { Kbd } from "../primitives/Button";
import { Scopes } from "./Sidebar.stories";

const meta = { title: "Composition/Shell", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

type Open = "info" | "notes" | "agent" | null;
const titles: Record<Exclude<Open, null>, string> = { info: "Info", notes: "Notes", agent: "Agent" };

/**
 * The window as one flat plane: the sidebar over the ground, the list and content columns on the
 * content colour, 1px separators between them, one 52px toolbar row across list and content, and
 * the single side panel (Info / Notes / Agent) that the toolbar's buttons switch.
 */
function Shell() {
  const [open, setOpen] = useState<Open>(null);
  const toggle = (which: Exclude<Open, null>) => (on: boolean) => setOpen(on ? which : null);
  return (
    <div className="m-6 grid h-[640px] w-[1240px] grid-cols-[220px_1px_340px_1px_minmax(0,1fr)] overflow-hidden rounded-window bg-ground shadow-window">
      <div className="grid grid-rows-[52px_minmax(0,1fr)]">
        <div className="flex items-center justify-end pr-2"><ToolbarButton aria-label="Hide sidebar" isSelected={false}><PanelLeft /></ToolbarButton></div>
        <Scopes />
      </div>
      <div className="bg-separator" />
      <div className="grid grid-rows-[52px_minmax(0,1fr)] bg-content">
        <header aria-label="List toolbar" className="flex h-[52px] items-center border-b border-separator pl-3.5 pr-2.5"><strong className="text-[13.5px] font-semibold">Inbox <span className="font-medium text-label-3">· 47</span></strong></header>
        <div className="p-3 text-[13px] text-label-3">Today · rows…</div>
      </div>
      <div className="bg-separator" />
      <div className="grid grid-rows-[52px_minmax(0,1fr)] bg-content">
        <Toolbar aria-label="Reader toolbar">
          <span />
          <ToolbarTitle title="Where the leaks are" subtitle="example.org · 12% · 9 min" />
          <ToolbarGroup>
            <ToolbarButton aria-label="Contents (t)" isSelected={false}><List /></ToolbarButton>
            <ToolbarButton aria-label="Info (i)" isSelected={open === "info"} onChange={toggle("info")}><Info /></ToolbarButton>
            <ToolbarButton aria-label="Notes (n)" isSelected={open === "notes"} onChange={toggle("notes")}><Highlighter /></ToolbarButton>
            <ToolbarButton aria-label="Reading settings" isSelected={false}><Type /></ToolbarButton>
            <AskButton aria-label="Ask" isSelected={open === "agent"} onChange={toggle("agent")}><Sparkles />Ask<Kbd>⌘J</Kbd></AskButton>
            <i aria-hidden="true" className="mx-1.5 h-4 w-px bg-separator" />
            <ToolbarButton aria-label="Add (⌘N)" isSelected={false}><Plus /></ToolbarButton>
            <ToolbarButton aria-label="Search (⌘K)" isSelected={false}><SearchIcon /></ToolbarButton>
          </ToolbarGroup>
        </Toolbar>
        <div className="grid grid-cols-[minmax(0,1fr)_auto]">
          <div className="p-6 text-[13px] text-label-3">Select something to read.</div>
          {open ? (
            <div className="grid grid-cols-[1px_360px]">
              <div className="bg-separator" />
              <Panel title={titles[open]} onClose={() => setOpen(null)}>
                <InspectorSection title={open === "agent" ? "Context" : open === "info" ? "Fields" : "Highlights"}><p className="m-0 text-[13.5px] text-label-2">{open === "agent" ? "the library" : open === "info" ? "Title · Creators · Tags" : "No notes yet."}</p></InspectorSection>
              </Panel>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => <Shell />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("option", { name: /Queue/ }));
    await expect(canvas.getByRole("option", { name: /Queue/ })).toHaveAttribute("aria-selected", "true");
    // Info, Notes and Ask are one switch: the panel shows the last one pressed, with its name on top.
    // (The panel slides in over 160ms, so visibility is awaited.)
    await userEvent.click(canvas.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(canvas.getByRole("complementary", { name: "Agent" })).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: "Info (i)" }));
    await waitFor(() => expect(canvas.getByRole("complementary", { name: "Info" })).toBeVisible());
    await expect(canvas.queryByRole("complementary", { name: "Agent" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Ask" })).toHaveAttribute("aria-pressed", "false");
    // × closes it.
    await userEvent.click(canvas.getByRole("button", { name: "Close Info" }));
    await expect(canvas.queryByRole("complementary")).toBeNull();
  },
};
