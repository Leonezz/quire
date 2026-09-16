import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import { useDragAndDrop, useListData } from "react-aria-components";
import { ItemGroup, ItemList, ItemRow } from "../primitives/ItemList";
import type { Selection } from "react-aria-components";

const items = [
  { id: "a", title: "Evaluation harnesses in the wild", source: "Systems Research Weekly · Mara Ilić", time: "09:12", gist: "Nine public harnesses and the assumptions each bakes in; most leak the test set through the prompt template.", minutes: 8, signals: ["code"] },
  { id: "b", title: "Position bias in retrieval-augmented evaluation", source: "arXiv cs.CL", time: "08:40", gist: "We measure how passage order shifts judged answer quality across 12 models.", minutes: 22, signals: ["math", "figures"] },
  { id: "c", title: "Why long-context models still need retrieval", source: "jxnl.co", time: "07:55", gist: "Cost, latency, and the failure modes that a bigger window does not fix.", minutes: 11, signals: [] },
  { id: "d", title: "Fine-tuning is not what you think", source: "eugeneyan.com", time: "07:30", gist: "Most fine-tuning wins in the wild are data cleaning wins.", minutes: 9, signals: ["code"], tag: "agent" as const },
];

const meta = { component: ItemList, title: "Primitives/ItemList", parameters: { layout: "fullscreen" } } satisfies Meta<typeof ItemList>;
export default meta;
type Story = StoryObj<typeof meta>;

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="m-6 h-[520px] w-[420px] overflow-hidden rounded-panel bg-content shadow-[0_0_0_1px_var(--separator-soft)]">{children}</div>;
}

export const Inbox: Story = {
  render: () => {
    const [selected, setSelected] = useState<Selection>(new Set(["a"]));
    return (
      <Frame>
        <ItemList aria-label="Inbox" items={items} selectionMode="single" selectedKeys={selected} onSelectionChange={setSelected}>
          {(item) => <ItemRow {...item} />}
        </ItemList>
      </Frame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rows = canvas.getAllByRole("row");
    await expect(rows).toHaveLength(4);
    await userEvent.click(rows[0]!);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect(rows[2]).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(rows[2]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("Fine"); // typeahead
    await expect(rows[3]).toHaveFocus();
  },
};

export const QueueReorder: Story = {
  render: () => {
    const list = useListData({ initialItems: items });
    const { dragAndDropHooks } = useDragAndDrop({
      getItems: (keys) => [...keys].map((key) => ({ "text/plain": list.getItem(key)?.title ?? "" })),
      onReorder: (e) => {
        if (e.target.dropPosition === "before") list.moveBefore(e.target.key, e.keys);
        else if (e.target.dropPosition === "after") list.moveAfter(e.target.key, e.keys);
      },
    });
    return (
      <Frame>
        <ItemGroup>Up next</ItemGroup>
        <ItemList aria-label="Queue" items={list.items} selectionMode="multiple" dragAndDropHooks={dragAndDropHooks}>
          {(item) => <ItemRow {...item} state="queued" />}
        </ItemList>
      </Frame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rows = canvas.getAllByRole("row");
    // Keyboard drag and drop comes with GridList: focus the drag handle, Enter to lift, ArrowDown to move, Enter to drop.
    await userEvent.click(rows[0]!);
    await expect(rows[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await expect(rows[1]).toHaveAttribute("aria-selected", "true");
  },
};
