import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import type { Key } from "react-aria-components";
import { BookOpen, FileText, Inbox, ListOrdered, Sparkles, Tag } from "lucide-react";
import { Sidebar, SidebarItem, SidebarSection } from "../primitives/Sidebar";

const meta = { title: "Primitives/Sidebar", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Every kind of entry the app's sidebar has: an action list with a count, a Library cut, a tag, a source with its health, a quiet opener. */
export function Scopes({ onChange }: { onChange?: (key: Key) => void }) {
  const [selected, setSelected] = useState<Key>("inbox");
  return (
    <div className="h-[520px] w-[220px] bg-ground">
      <Sidebar aria-label="Scopes" className="h-full pt-2" selectedKeys={new Set([selected])} onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; if (key !== undefined) { setSelected(key); onChange?.(key); } }}>
        <SidebarSection>
          <SidebarItem id="inbox" icon={<Inbox />} label="Inbox" count={47} />
          <SidebarItem id="queue" icon={<ListOrdered />} label="Queue" count={3} />
          <SidebarItem id="agent" icon={<Sparkles />} label="Agent" count={2} />
        </SidebarSection>
        <SidebarSection title="Library">
          <SidebarItem id="library:all" icon={<BookOpen />} label="All" />
          <SidebarItem id="library:articles" icon={<FileText />} label="Articles" />
          <SidebarItem id="library:papers" icon={<FileText />} label="Papers" />
          <SidebarItem id="library:artifacts" icon={<FileText />} label="Artifacts" />
        </SidebarSection>
        <SidebarSection title="Tags">
          <SidebarItem id="tag:react" icon={<Tag />} label="react" count={3} />
          <SidebarItem id="tag:weekly" icon={<Tag />} label="weekly" count={2} />
          <SidebarItem id="tags:all" label="All tags…" quiet />
        </SidebarSection>
        <SidebarSection title="Sources">
          <SidebarItem id="source:1" health="ok" label="阮一峰的网络日志" count={3} />
          <SidebarItem id="source:2" health="paused" label="arXiv cs.CL" count={0} />
          <SidebarItem id="source:3" health="failing" label="A feed that stopped answering" count={1} />
          <SidebarItem id="sources" label="Manage sources…" quiet />
        </SidebarSection>
      </Sidebar>
    </div>
  );
}

export const Default: Story = {
  render: () => <Scopes />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Counts and health are part of the option's accessible name.
    await expect(canvas.getByRole("option", { name: /Inbox.*47/ })).toHaveAttribute("aria-selected", "true");
    await expect(within(canvas.getByRole("option", { name: /arXiv/ })).getByRole("img", { name: "paused" })).toBeVisible();
    // Section headers are not options: the sections are groups inside one listbox.
    await expect(canvas.getAllByRole("group")).toHaveLength(4);
    await expect(canvas.queryByRole("option", { name: "Library" })).toBeNull();
    // ↓ crosses from the first section into Library, then on into Tags; Enter selects the focused scope.
    await userEvent.click(canvas.getByRole("option", { name: /Agent/ }));
    await userEvent.keyboard("{ArrowDown}");
    await expect(canvas.getByRole("option", { name: "All" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    await expect(canvas.getByRole("option", { name: /react/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("option", { name: /react/ })).toHaveAttribute("aria-selected", "true");
    await expect(canvas.getByRole("option", { name: /Agent/ })).toHaveAttribute("aria-selected", "false");
  },
};
