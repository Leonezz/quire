import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useState } from "react";
import { Button } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Popover } from "../primitives/Popover";
import { Segment, Segmented } from "../primitives/Segmented";
import { DialogTrigger, Sheet, SheetDialog, SheetFooter } from "../primitives/Sheet";
import { Switch } from "../primitives/Switch";

// The transitions.dev recipes in one place (theme.css): a sliding segmented pill, a bouncing switch, a drawn
// checkmark, a popover that grows from its trigger and a sheet that scales up. Open it to watch them move.
const meta = { title: "Foundations/Motion", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Frame() {
  const [measure, setMeasure] = useState("normal");
  const [justify, setJustify] = useState(false);
  const [capture, setCapture] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  return (
    <div className="grid w-[420px] gap-4">
      <Segmented aria-label="Measure" className="flex" selectedKeys={[measure]} onSelectionChange={(keys) => { const key = [...keys][0]; if (key) setMeasure(String(key)); }}>
        <Segment id="narrow" className="flex-1">Narrow</Segment>
        <Segment id="normal" className="flex-1">Normal</Segment>
        <Segment id="wide" className="flex-1">Wide</Segment>
      </Segmented>
      <Switch isSelected={justify} onChange={setJustify}>Justify text</Switch>
      <Checkbox isSelected={capture} onChange={setCapture}>Keep the raw page capture</Checkbox>
      <DialogTrigger>
        <Button variant="quiet">Reading settings</Button>
        <Popover placement="bottom start" aria-label="Reading settings" className="w-[240px]">
          <p className="m-0 text-[13px] text-label-2">A popover grows from its trigger.</p>
        </Popover>
      </DialogTrigger>
      <DialogTrigger isOpen={sheetOpen} onOpenChange={setSheetOpen}>
        <Button variant="quiet">Open sheet</Button>
        <Sheet>
          <SheetDialog title="A sheet">
            <p className="m-0 text-[13.5px] text-label-2">It scales up from .96 and dips back on close.</p>
            <SheetFooter><Button variant="primary" onPress={() => setSheetOpen(false)}>Done</Button></SheetFooter>
          </SheetDialog>
        </Sheet>
      </DialogTrigger>
    </div>
  );
}

export const Recipes: Story = {
  render: () => <Frame />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: "Wide" }));
    await expect(canvas.getByRole("radio", { name: "Wide" })).toBeChecked();
    await userEvent.click(canvas.getByRole("switch", { name: "Justify text" }));
    await expect(canvas.getByRole("switch", { name: "Justify text" })).toBeChecked();
    await userEvent.click(canvas.getByRole("button", { name: "Open sheet" }));
    const body = within(document.body);
    await userEvent.click(await body.findByRole("button", { name: "Done" }));
    // The sheet stays mounted through its exit transition, then leaves.
    await waitFor(() => expect(body.queryByRole("dialog", { name: "A sheet" })).not.toBeInTheDocument());
  },
};
