import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import { CommandPalette, type CommandPaletteItem } from "../primitives/CommandPalette";
import { Button } from "../primitives/Button";

const corpus: CommandPaletteItem[] = [
  { id: "m1", kind: "material", title: "Attention Is All You Need", subtitle: "arxiv.org · 2017" },
  { id: "m2", kind: "material", title: "CSS Custom Highlight API", subtitle: "developer.mozilla.org" },
  { id: "i1", kind: "item", title: "Evaluation harnesses in the wild", subtitle: "Systems Research Weekly · today" },
  { id: "i2", kind: "item", title: "Position bias in retrieval-augmented evaluation", subtitle: "arXiv cs.CL · yesterday" },
];

const meta = { title: "Primitives/CommandPalette", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Frame() {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? corpus.filter((item) => words.every((word) => `${item.title} ${item.subtitle ?? ""}`.toLowerCase().includes(word))) : [];
  return (
    <div className="h-[640px] w-[1000px] bg-ground p-6">
      <p className="text-[13px] text-label-2">Picked: {picked ?? "nothing"}</p>
      <Button onPress={() => setOpen(true)}>Search</Button>
      <CommandPalette aria-label="Search" isOpen={open} onOpenChange={setOpen} placeholder="Search your library and inbox…" query={query} onQueryChange={setQuery} items={hits}
        status={query.trim() ? undefined : "Type to search titles, bylines and sources."} emptyText="Nothing matches."
        onSelect={(id) => { setPicked(id); setOpen(false); }} />
    </div>
  );
}

export const Palette: Story = {
  render: () => <Frame />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const input = await body.findByRole("searchbox", { name: "Search" });
    await expect(input).toHaveFocus();
    await userEvent.keyboard("eval");
    const list = await body.findByRole("listbox", { name: "Results" });
    await expect(within(list).getAllByRole("option")).toHaveLength(2);
    // Focus stays in the field; ↓ moves the virtual focus to the second hit, Enter selects it.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect(input).toHaveFocus();
    await expect(within(list).getByRole("option", { name: /Position bias/ })).toHaveAttribute("data-focused", "true");
    await userEvent.keyboard("{Enter}");
    await expect(within(canvasElement).getByText("Picked: i2")).toBeInTheDocument();
    // Escape closes.
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Search" }));
    await body.findByRole("searchbox", { name: "Search" });
    await userEvent.keyboard("zzz");
    await expect(await body.findByText("Nothing matches.")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await expect(body.queryByRole("searchbox", { name: "Search" })).toBeNull();
  },
};
