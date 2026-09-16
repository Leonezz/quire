import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Button, Kbd } from "../primitives/Button";

const meta = { component: Button, title: "Primitives/Button" } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary">Read now <Kbd>↵</Kbd></Button>
      <Button>Queue <Kbd>q</Kbd></Button>
      <Button variant="plain">Open</Button>
      <Button variant="quiet">Dismiss <Kbd>e</Kbd></Button>
      <Button size="sm">Retry</Button>
      <Button isDisabled>Disabled</Button>
    </div>
  ),
};

export const PressAndKeyboard: Story = {
  args: { children: "Keep", variant: "primary", onPress: fn() },
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "Keep" });
    await userEvent.click(button);
    await userEvent.keyboard("{Enter}");
    await expect(args.onPress).toHaveBeenCalledTimes(2);
    await expect(button).toHaveFocus();
  },
};
