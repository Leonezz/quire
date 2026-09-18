import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { useState } from "react";
import { Chip, TagInput } from "../primitives/TagInput";

const meta = { title: "Primitives/TagInput", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const suggestions = ["evaluation", "retrieval", "transformers", "css", "systems"];
const onCommit = fn();

function Frame() {
  const [tags, setTags] = useState<string[]>(["css"]);
  return (
    <div className="w-[420px]">
      <TagInput label="Tags" value={tags} onChange={setTags} onCommit={onCommit} suggestions={suggestions} />
      <p className="mt-3 text-[12.5px] text-label-2">Saved: {tags.join(", ") || "none"}</p>
    </div>
  );
}

export const Editing: Story = {
  render: () => <Frame />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const input = canvas.getByRole("combobox", { name: "Tags" });
    await userEvent.click(input);
    // Enter adds what was typed; the chip carries a labelled remove button.
    await userEvent.keyboard("systems{Enter}");
    await expect(canvas.getByRole("button", { name: "Remove systems" })).toBeVisible();
    await expect(onCommit).toHaveBeenLastCalledWith(["css", "systems"]);
    // A duplicate (any case) is not added twice.
    await userEvent.keyboard("CSS{Enter}");
    await expect(canvas.getAllByRole("button", { name: /^Remove/ })).toHaveLength(2);
    // Typing opens suggestions minus the chosen ones; ↓ moves into them and Enter picks.
    await userEvent.keyboard("trans");
    const option = await body.findByRole("option", { name: "transformers" });
    await expect(option).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await expect(option).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("button", { name: "Remove transformers" })).toBeVisible();
    // Backspace on an empty field removes the last chip; × removes any.
    await userEvent.click(input);
    await userEvent.keyboard("{Backspace}");
    await expect(canvas.queryByRole("button", { name: "Remove transformers" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Remove css" }));
    await expect(canvas.getByText("Saved: systems")).toBeInTheDocument();
  },
};

export const Chips: Story = {
  render: () => (
    <div className="flex flex-wrap gap-1.5">
      <Chip>evaluation</Chip>
      <Chip tone="accent">rebuilt</Chip>
      <Chip onRemove={() => undefined}>removable</Chip>
    </div>
  ),
};
