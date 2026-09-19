import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import { CreatorRow } from "../primitives/CreatorRow";
import { Button } from "../primitives/Button";

const meta = { title: "Primitives/CreatorRow", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const roles = [{ id: "author", label: "Author" }, { id: "editor", label: "Editor" }, { id: "translator", label: "Translator" }];
type Creator = { role: string; name: string };
const swap = (list: Creator[], a: number, b: number) => list.map((item, at) => (at === a ? list[b]! : at === b ? list[a]! : item));

function Frame() {
  const [creators, setCreators] = useState<Creator[]>([{ role: "author", name: "Vaswani, Ashish" }, { role: "author", name: "Shazeer, Noam" }, { role: "editor", name: "Polosukhin, Illia" }]);
  const [committed, setCommitted] = useState(0);
  return (
    <div className="grid w-[460px] gap-1.5">
      {creators.map((creator, index) => (
        <CreatorRow key={index} index={index} count={creators.length} role={creator.role} roles={roles} name={creator.name}
          onRoleChange={(role) => setCreators((list) => list.map((item, at) => (at === index ? { ...item, role } : item)))}
          onNameChange={(name) => setCreators((list) => list.map((item, at) => (at === index ? { ...item, name } : item)))}
          onNameCommit={() => setCommitted((n) => n + 1)}
          onMoveUp={() => setCreators((list) => swap(list, index, index - 1))}
          onMoveDown={() => setCreators((list) => swap(list, index, index + 1))}
          onRemove={() => setCreators((list) => list.filter((_, at) => at !== index))} />
      ))}
      <Button size="sm" variant="plain" className="justify-self-start" onPress={() => setCreators((list) => [...list, { role: "author", name: "" }])}>+ Add creator</Button>
      <p className="text-[12.5px] text-label-2">Order: {creators.map((creator) => `${creator.name || "?"} (${creator.role})`).join(" · ")} · committed {committed}</p>
    </div>
  );
}

export const Editing: Story = {
  render: () => <Frame />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    // The first row's ↑ is disabled, the last row's ↓ too; every button is reachable by Tab.
    await expect(canvas.getByRole("button", { name: "Move Vaswani, Ashish up" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Move Polosukhin, Illia down" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Move Shazeer, Noam up" }));
    await expect(canvas.getByText(/^Order: Shazeer, Noam \(author\) · Vaswani, Ashish/)).toBeInTheDocument();
    // ⌥↓ inside the name field moves the row down again; Enter commits.
    const first = canvas.getByRole("textbox", { name: "Name of creator 1" });
    await userEvent.click(first);
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await expect(canvas.getByText(/^Order: Vaswani, Ashish \(author\) · Shazeer, Noam/)).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText(/committed 1$/)).toBeInTheDocument();
    // The role menu is a MenuSelect: ↓ opens, Enter picks.
    canvas.getByRole("button", { name: "Role of Polosukhin, Illia: Editor" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    await body.findByRole("menu");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await expect(canvas.getByText(/Polosukhin, Illia \(translator\)/)).toBeInTheDocument();
    // × removes; the row count follows.
    await userEvent.click(canvas.getByRole("button", { name: "Remove Shazeer, Noam" }));
    await expect(canvas.getAllByRole("group", { name: /^Creator \d of 2$/ })).toHaveLength(2);
    // A new row is empty and named by its position.
    await userEvent.click(canvas.getByRole("button", { name: "+ Add creator" }));
    await expect(canvas.getByRole("button", { name: "Remove creator 3" })).toBeVisible();
  },
};
