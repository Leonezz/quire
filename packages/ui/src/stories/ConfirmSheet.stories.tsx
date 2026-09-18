import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { useState } from "react";
import { ConfirmSheet } from "../primitives/ConfirmSheet";
import { NumberField } from "../primitives/NumberField";
import { Button } from "../primitives/Button";

const meta = { title: "Primitives/ConfirmSheet", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const onConfirm = fn();

function Frame() {
  const [open, setOpen] = useState(true);
  return (
    <div className="h-[480px] w-[900px] bg-ground p-6">
      <Button onPress={() => setOpen(true)}>Delete 3</Button>
      <ConfirmSheet isOpen={open} title="Delete 3 materials?" message="Highlights and notes go with them. Inbox history keeps the titles." confirmLabel="Delete 3"
        onConfirm={() => { onConfirm(); setOpen(false); }} onCancel={() => setOpen(false)} />
    </div>
  );
}

export const Confirm: Story = {
  render: () => <Frame />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Delete 3 materials?" });
    // The confirming button takes focus, so Enter confirms; Esc cancels.
    await expect(within(dialog).getByRole("button", { name: "Delete 3" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(body.queryByRole("dialog")).toBeNull();
    await expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Delete 3" }));
    await body.findByRole("dialog");
    await userEvent.keyboard("{Enter}");
    await expect(onConfirm).toHaveBeenCalledTimes(1);
  },
};

function Numbers() {
  const [value, setValue] = useState(30);
  const error = value < 5 || value > 1440 ? "Between 5 and 1440 minutes." : undefined;
  return (
    <div className="p-6">
      <NumberField label="Sync interval" value={value} onChange={setValue} minValue={0} maxValue={2000} unit="min" errorMessage={error} />
      <p className="mt-2 text-[12px] text-label-3">Value: {value}</p>
    </div>
  );
}

export const Number: Story = {
  render: () => <Numbers />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "Sync interval" });
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowUp}");
    await expect(input).toHaveValue("31");
    await userEvent.click(canvas.getByRole("button", { name: /Decrease/ }));
    await expect(input).toHaveValue("30");
    await userEvent.clear(input);
    await userEvent.keyboard("3{Tab}");
    await expect(canvas.getByText(/^Value:/)).toHaveTextContent("Value: 3");
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Between 5 and 1440 minutes.");
  },
};
