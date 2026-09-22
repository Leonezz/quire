import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import { Checkbox } from "../primitives/Checkbox";

const meta = { title: "Primitives/Checkbox", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Frame() {
  const [on, setOn] = useState(true);
  return (
    <div className="grid w-[420px] gap-3">
      <Checkbox isSelected={on} onChange={setOn}>Include the saved original page so it can be reproduced</Checkbox>
      <Checkbox isDisabled>Disabled</Checkbox>
      <p className="text-[12.5px] text-label-2">Included: {on ? "yes" : "no"}</p>
    </div>
  );
}

export const Toggling: Story = {
  render: () => <Frame />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByRole("checkbox", { name: "Include the saved original page so it can be reproduced" });
    await expect(box).toBeChecked();
    await userEvent.click(canvas.getByText("Include the saved original page so it can be reproduced"));
    await expect(box).not.toBeChecked();
    box.focus();
    await userEvent.keyboard(" ");
    await expect(canvas.getByText("Included: yes")).toBeInTheDocument();
    await expect(canvas.getByRole("checkbox", { name: "Disabled" })).toBeDisabled();
  },
};
