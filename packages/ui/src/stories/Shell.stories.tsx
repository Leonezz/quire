import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import type { Key } from "react-aria-components";
import { BookOpen, Inbox, ListOrdered, Radio, Search as SearchIcon, Sparkles, Text, List, Highlighter } from "lucide-react";
import { AskButton, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle } from "../primitives/Toolbar";
import { Sidebar, SidebarItem, SidebarSection } from "../primitives/Sidebar";
import { Segment, Segmented } from "../primitives/Segmented";
import { Inspector, InspectorPanel, InspectorSection, InspectorTab, InspectorTabs } from "../primitives/Inspector";
import { Button, Kbd } from "../primitives/Button";

const meta = { title: "Composition/Shell", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Shell() {
  const [askOpen, setAskOpen] = useState(false);
  const [tab, setTab] = useState<Key>("contents");
  return (
    <div className="m-6 grid h-[640px] w-[1240px] grid-cols-[236px_minmax(0,1fr)_360px] grid-rows-[56px_minmax(0,1fr)] gap-3 overflow-hidden rounded-window bg-ground p-3 shadow-window">
      <Sidebar aria-label="Sidebar" className="row-span-2" defaultSelectedKeys={["inbox"]}>
        <SidebarSection title="Read">
          <SidebarItem id="inbox" icon={<Inbox />} label="Inbox" count={23} />
          <SidebarItem id="queue" icon={<ListOrdered />} label="Queue" count={12} />
          <SidebarItem id="library" icon={<BookOpen />} label="Library" />
          <SidebarItem id="sources" icon={<Radio />} label="Sources" attention />
        </SidebarSection>
      </Sidebar>
      <Toolbar aria-label="Toolbar" className="col-span-2">
        <ToolbarGroup><ToolbarButton aria-label="Toggle sidebar"><List /></ToolbarButton></ToolbarGroup>
        <ToolbarTitle title="Inbox" subtitle="23 unread · 9 sources" />
        <ToolbarGroup>
          <Segmented aria-label="Group by" defaultSelectedKeys={["date"]}><Segment id="date">Date</Segment><Segment id="source">Source</Segment></Segmented>
          <ToolbarButton aria-label="Search"><SearchIcon /></ToolbarButton>
          <AskButton aria-label="Ask" isSelected={askOpen} onChange={(open) => { setAskOpen(open); if (open) setTab("agent"); }}><Sparkles />Ask<Kbd>⌘J</Kbd></AskButton>
        </ToolbarGroup>
      </Toolbar>
      <div className="rounded-panel bg-content shadow-[0_0_0_1px_var(--separator-soft)]" />
      <Inspector aria-label="Inspector" selectedKey={tab} onSelectionChange={setTab}>
        <InspectorTabs>
          <InspectorTab id="contents"><Text />Contents</InspectorTab>
          <InspectorTab id="notes"><Highlighter />Notes</InspectorTab>
          <InspectorTab id="agent"><Sparkles />Agent</InspectorTab>
        </InspectorTabs>
        <InspectorPanel id="contents"><InspectorSection title="Contents"><p className="text-[13.5px] text-label-2">Where the leaks are · What a run needs to record</p></InspectorSection></InspectorPanel>
        <InspectorPanel id="notes"><InspectorSection title="Notes"><p className="text-[13.5px] text-label-2">No notes yet.</p></InspectorSection></InspectorPanel>
        <InspectorPanel id="agent"><InspectorSection title="Context"><Button size="sm">this article</Button></InspectorSection></InspectorPanel>
      </Inspector>
    </div>
  );
}

export const Default: Story = {
  render: () => <Shell />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("option", { name: /Queue/ }));
    await expect(canvas.getByRole("option", { name: /Queue/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(canvas.getByRole("button", { name: "Ask" }));
    await expect(canvas.getByRole("tab", { name: /Agent/ })).toHaveAttribute("aria-selected", "true");
  },
};
