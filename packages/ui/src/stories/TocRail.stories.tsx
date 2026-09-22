import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { useState } from "react";
import { TocRail, type TocEntry } from "../primitives/TocRail";

const entries: TocEntry[] = [
  { id: "intro", label: "Introduction", level: 1 },
  { id: "background", label: "Background", level: 1 },
  { id: "arch", label: "Model architecture", level: 1 },
  { id: "stacks", label: "Encoder and decoder stacks", level: 2 },
  { id: "attention", label: "Attention", level: 2 },
  { id: "sdpa", label: "Scaled dot-product attention", level: 3 },
  { id: "mha", label: "Multi-head attention", level: 3 },
  { id: "ffn", label: "Position-wise feed-forward networks", level: 2 },
  { id: "pos", label: "Positional encoding", level: 2 },
  { id: "why", label: "Why self-attention", level: 1 },
  { id: "training", label: "Training", level: 1 },
  { id: "results", label: "Results", level: 1 },
  { id: "conclusion", label: "Conclusion", level: 1 },
];

const meta = { component: TocRail, title: "Primitives/TocRail", parameters: { layout: "fullscreen" }, args: { entries, onSelect: fn(), "aria-label": "Contents" } } satisfies Meta<typeof TocRail>;
export default meta;
type Story = StoryObj<typeof meta>;

function Frame({ pinned = false, resting = "ticks" }: { pinned?: boolean; resting?: "ticks" | "hidden" }) {
  const [active, setActive] = useState("attention");
  return (
    <div className="relative m-6 h-[480px] w-[640px] overflow-hidden rounded-panel bg-content shadow-[0_0_0_1px_var(--separator-soft)]">
      <p className="p-6 text-[13px] text-label-2">Current section: {entries.find((entry) => entry.id === active)?.label}</p>
      <div className="absolute inset-y-4 right-1.5 flex items-center">
        <TocRail aria-label="Contents" entries={entries} activeId={active} onSelect={setActive} pinned={pinned} resting={resting} />
      </div>
    </div>
  );
}

export const Rail: Story = {
  render: () => <Frame />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole("navigation", { name: "Contents" });
    const buttons = within(nav).getAllByRole("button");
    await expect(buttons).toHaveLength(13);
    await expect(within(nav).getByRole("button", { name: "Attention" })).toHaveAttribute("aria-current", "location");
    // Quiet by default: no labels, no magnification.
    await expect(nav).not.toHaveAttribute("data-magnified");
    await expect(within(nav).queryByText("Training")).toBeNull();
    // Hovering a tick magnifies locally and shows only that heading's label.
    await userEvent.hover(buttons[10]!);
    await expect(nav).toHaveAttribute("data-magnified", "true");
    await expect(within(nav).getByText("Training")).toBeVisible();
    await expect(within(nav).queryByText("Results")).toBeNull();
    await userEvent.unhover(buttons[10]!);
    await expect(within(nav).queryByText("Training")).toBeNull();
    // Keyboard: focus magnifies the focused entry; arrows move; Enter selects.
    await userEvent.tab();
    await expect(buttons[0]).toHaveFocus();
    await expect(within(nav).getByText("Introduction")).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await expect(canvas.getByText("Current section: Model architecture")).toBeInTheDocument();
    await expect(within(nav).getByRole("button", { name: "Model architecture" })).toHaveAttribute("aria-current", "location");
    await userEvent.keyboard("{End}");
    await expect(buttons[12]).toHaveFocus();
  },
};

export const Pinned: Story = {
  render: () => <Frame pinned />,
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole("navigation", { name: "Contents" });
    await expect(nav).toHaveAttribute("data-expanded", "true");
    await expect(within(nav).getByText("Conclusion")).toBeVisible();
  },
};

/** The readers' resting state: nothing at the edge until the pointer reaches the hot zone, the rail is focused, or `t` pins it. */
export const HiddenAtRest: Story = {
  render: () => <Frame resting="hidden" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole("navigation", { name: "Contents" });
    const list = nav.querySelector("ol")!;
    const buttons = within(nav).getAllByRole("button");
    await expect(nav).toHaveAttribute("data-resting", "hidden");
    await expect(nav).toHaveAttribute("data-revealed", "false");
    await expect(list).toHaveClass("opacity-0");
    // The pointer in the hot zone along the edge brings the ticks in; leaving lets them go after a moment.
    await userEvent.hover(nav.querySelector("[data-hot-zone]")!);
    await expect(nav).toHaveAttribute("data-revealed", "true");
    await userEvent.hover(buttons[10]!);
    // The ticks fade in over a moment; the label is visible once they are.
    await waitFor(() => expect(within(nav).getByText("Training")).toBeVisible());
    await userEvent.unhover(buttons[10]!);
    await expect(nav).toHaveAttribute("data-revealed", "true");
    await waitFor(() => expect(nav).toHaveAttribute("data-revealed", "false"), { timeout: 2000 });
    // Keyboard focus reveals the rail too, and the arrows still walk it.
    await userEvent.tab();
    await expect(buttons[0]).toHaveFocus();
    await expect(nav).toHaveAttribute("data-revealed", "true");
    await waitFor(() => expect(within(nav).getByText("Introduction")).toBeVisible());
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await expect(canvas.getByText("Current section: Model architecture")).toBeInTheDocument();
    // Focus leaving the rail (a click in the page) lets it rest again.
    await userEvent.click(canvas.getByText("Current section: Model architecture"));
    await waitFor(() => expect(nav).toHaveAttribute("data-revealed", "false"), { timeout: 2000 });
  },
};

export const HiddenAtRestPinned: Story = {
  render: () => <Frame resting="hidden" pinned />,
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole("navigation", { name: "Contents" });
    await expect(nav).toHaveAttribute("data-revealed", "true");
    await expect(within(nav).getByText("Conclusion")).toBeVisible();
  },
};
