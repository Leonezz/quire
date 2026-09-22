import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { useState } from "react";
import { ChoiceChips, type ChoiceChipOption } from "../primitives/ChoiceChips";

const meta = { title: "Primitives/ChoiceChips", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const problems: ChoiceChipOption[] = [
  { id: "missing_content", label: "Text or sections are missing" },
  { id: "wrong_order", label: "Paragraphs out of order" },
  { id: "tables", label: "Tables mangled" },
  { id: "images", label: "Figures missing or wrong", isDisabled: true },
  { id: "other", label: "Something else" },
];
const onChange = fn();

function Frame() {
  const [value, setValue] = useState<string[]>(["tables"]);
  return (
    <div className="grid w-[460px] gap-3">
      <ChoiceChips aria-label="What went wrong" options={problems} value={value} onChange={(ids) => { onChange(ids); setValue(ids); }} />
      <p className="text-[12.5px] text-label-2">Chosen: {value.join(", ") || "none"}</p>
    </div>
  );
}

export const Toggling: Story = {
  render: () => <Frame />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = canvas.getByRole("toolbar", { name: "What went wrong" });
    const chips = within(group).getAllByRole("button");
    await expect(chips).toHaveLength(5);
    await expect(chips[2]).toHaveAttribute("aria-pressed", "true");
    // A click toggles a chip on; the change hands back the ids in option order.
    await userEvent.click(chips[0]!);
    await expect(onChange).toHaveBeenLastCalledWith(["missing_content", "tables"]);
    // → moves along the chips (skipping the disabled one), Space toggles the focused chip.
    chips[0]!.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await expect(chips[2]).toHaveFocus();
    await userEvent.keyboard(" ");
    await expect(chips[2]).toHaveAttribute("aria-pressed", "false");
    await userEvent.keyboard("{ArrowRight}");
    await expect(chips[4]).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText("Chosen: missing_content, other")).toBeInTheDocument();
  },
};
