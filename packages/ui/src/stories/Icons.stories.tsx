import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { Bookmark, Check, ChevronDown, Copy, Inbox, Sparkles, X } from "lucide-react";
import { Button } from "../primitives/Button";
import { Icon, type IconSize } from "../primitives/Icon";
import { ToolbarButton } from "../primitives/Toolbar";
import { Chip } from "../primitives/TagInput";

const meta = { title: "Foundations/Icons" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const scale: { size: IconSize; px: number; use: string }[] = [
  { size: "sm", px: 14, use: "inline in 12–13px text: chevrons, chips, status marks" },
  { size: "md", px: 18, use: "every button and toolbar icon, sidebar items, row actions" },
  { size: "lg", px: 22, use: "empty states, large marks" },
];

/** The three sizes beside 13px text, then the slots that apply them: a toolbar button, a text button, a chip. */
export const Scale: Story = {
  render: () => (
    <div className="grid max-w-[560px] gap-4 text-[13px] leading-5 text-label">
      {scale.map(({ size, px, use }) => (
        <div key={size} className="flex items-center gap-3">
          <span className="grid w-[120px] grid-cols-3 place-items-center gap-2 rounded-card bg-content py-2 shadow-[0_0_0_1px_var(--separator)]">
            <Icon of={Sparkles} size={size} /><Icon of={Inbox} size={size} /><Icon of={Copy} size={size} />
          </span>
          <span className="w-[72px] font-mono text-[12px] text-label-2">{size} · {px}px</span>
          <span className="text-label-2">{use}</span>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 border-t border-separator pt-4">
        <ToolbarButton aria-label="Toolbar icon (md)"><Sparkles /></ToolbarButton>
        <Button size="sm"><Copy />Copy BibTeX</Button>
        <Button size="sm" aria-label="Icon-only button (md)"><Copy /></Button>
        <Chip onRemove={() => undefined} removeLabel="Remove tag">tag</Chip>
        <span className="inline-flex items-center gap-1 text-label-2"><Icon of={Check} size="sm" className="text-green" />done</span>
        <span className="inline-flex items-center gap-1 text-label-2"><Icon of={ChevronDown} size="sm" />sort</span>
        <Icon of={Bookmark} size="sm" label="kept" className="fill-current text-label-3" />
        <Icon of={X} size="lg" label="large mark" />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const measure = (element: Element) => getComputedStyle(element).width;
    await expect(measure(canvas.getByRole("img", { name: "kept" }))).toBe("14px");
    await expect(measure(canvas.getByRole("img", { name: "large mark" }))).toBe("22px");
    await expect(measure(canvas.getByRole("button", { name: "Toolbar icon (md)" }).querySelector("svg")!)).toBe("18px");
    await expect(measure(canvas.getByRole("button", { name: "Icon-only button (md)" }).querySelector("svg")!)).toBe("18px");
    await expect(measure(canvas.getByRole("button", { name: "Copy BibTeX" }).querySelector("svg")!)).toBe("14px");
    await expect(measure(canvas.getByRole("button", { name: "Remove tag" }).querySelector("svg")!)).toBe("14px");
  },
};
