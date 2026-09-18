import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AgentToolLine, AgentTurn, CitationPill } from "../primitives/AgentTranscript";

const meta = { title: "Primitives/AgentTranscript", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const onOpen = fn();

function Transcript() {
  return (
    <div className="glass grid w-[360px] gap-3 rounded-panel p-4">
      <AgentTurn role="user">Explain the Highlight registry in two sentences.</AgentTurn>
      <div className="grid gap-1.5">
        <AgentToolLine name="library_search" status="done" summary='"highlight registry" → 4 hits' />
        <AgentToolLine name="read_material" status="running" summary="CSS Custom Highlight API" />
        <AgentToolLine name="fetch_url" status="failed" summary="HTTP 403" />
      </div>
      <AgentTurn role="agent">
        <p className="m-0">
          <code className="rounded-[4px] bg-fill px-1 font-mono text-[12px]">CSS.highlights</code> is a map from a name to a <strong>Highlight</strong>, a set of ranges styled through <code className="rounded-[4px] bg-fill px-1 font-mono text-[12px]">::highlight()</code>.
          The registry lives on the document, so styling survives re-renders <CitationPill id="526130b61f003c33" label="CSS Custom Highlight API" onPress={() => onOpen("526130b61f003c33")} /> and a second source agrees <CitationPill id="63d7dedf6dd9973c" onPress={() => onOpen("63d7dedf6dd9973c")} />.
        </p>
      </AgentTurn>
    </div>
  );
}

export const Turns: Story = {
  render: () => <Transcript />,
  play: async ({ canvasElement }) => {
    onOpen.mockClear();
    const canvas = within(canvasElement);
    // Turns lift in with agent-pop (opacity from 0), so presence is the stable assertion here.
    await expect(canvas.getByText("Explain the Highlight registry in two sentences.")).toBeInTheDocument();
    await expect(canvas.getByRole("status")).toHaveTextContent("read_material");
    await expect(within(canvas.getByRole("status")).getByRole("img", { name: "running" })).toBeInTheDocument();
    // The citation pill is a button: Tab reaches it, Enter and Space open the cited material, a click does too.
    const pill = canvas.getByRole("button", { name: "Open CSS Custom Highlight API" });
    await userEvent.tab();
    await expect(pill).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(onOpen).toHaveBeenCalledWith("526130b61f003c33");
    await userEvent.tab();
    const bare = canvas.getByRole("button", { name: "Open material 63d7dedf6dd9973c" });
    await expect(bare).toHaveFocus();
    await expect(bare).toHaveTextContent("63d7dedf");
    await userEvent.keyboard(" ");
    await expect(onOpen).toHaveBeenLastCalledWith("63d7dedf6dd9973c");
    await userEvent.click(pill);
    await expect(onOpen).toHaveBeenCalledTimes(3);
  },
};
