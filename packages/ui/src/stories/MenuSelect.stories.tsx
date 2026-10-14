import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useState } from "react";
import { BookOpen } from "lucide-react";
import { Icon } from "../primitives/Icon";
import { MenuSelect, type MenuSelectOption } from "../primitives/MenuSelect";

const meta = { title: "Primitives/MenuSelect", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const kinds: MenuSelectOption[] = [
  { id: "any", label: "Any type", count: 12 },
  { id: "blogPost", label: "Blog post", count: 7 },
  { id: "preprint", label: "Preprint", count: 4 },
  { id: "book", label: "Book", count: 1 },
];

function Frame() {
  const [value, setValue] = useState("any");
  return (
    <div className="grid w-[320px] gap-3">
      <MenuSelect aria-label="Type" icon={<Icon of={BookOpen} size="sm" />} value={value} options={kinds} onChange={setValue} />
      <p className="text-[12.5px] text-label-2">Chosen: {value}</p>
    </div>
  );
}

export const Keyboard: Story = {
  render: () => <Frame />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByRole("button", { name: "Type: Any type" });
    trigger.focus();
    // ↓ opens the menu with the current option focused; ↓↓ then Enter picks the third.
    await userEvent.keyboard("{ArrowDown}");
    const menu = await body.findByRole("menu");
    await expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(4);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await expect(canvas.getByText("Chosen: preprint")).toBeInTheDocument();
    await waitFor(() => expect(body.queryByRole("menu")).toBeNull());
    // Escape closes without changing anything.
    await userEvent.click(canvas.getByRole("button", { name: "Type: Preprint" }));
    // The menu takes focus once it has started opening; Escape closes it, and it leaves after its close transition.
    const reopened = await body.findByRole("menu");
    await waitFor(() => expect(reopened.contains(reopened.ownerDocument.activeElement)).toBe(true));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(body.queryByRole("menu")).toBeNull());
    await expect(canvas.getByText("Chosen: preprint")).toBeInTheDocument();
  },
};
