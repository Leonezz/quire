import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useState } from "react";
import { CompanionPlayer, NowPlayingBar, VideoDockFrame } from "../primitives/MediaPlayer";

const meta = {
  title: "Primitives/MediaPlayer",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function PlayerHarness() {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(291);
  const [speed, setSpeed] = useState(1);
  const [following, setFollowing] = useState(true);
  const [drifted, setDrifted] = useState(true);
  const [videoOpen, setVideoOpen] = useState(false);
  const [cached, setCached] = useState(false);

  return (
    <div className="grid w-[620px] gap-4">
      {videoOpen ? (
        <VideoDockFrame title="Why Pre-training Scaling Changed Shape" onClose={() => setVideoOpen(false)}>
          <div className="flex h-full items-center justify-center text-[12px] text-white/80">16:9 synced stage</div>
        </VideoDockFrame>
      ) : null}
      <CompanionPlayer
        playing={playing}
        positionSec={position}
        durationSec={6130}
        playbackSpeed={speed}
        chapterTitle="Why Pre-training Scaling Changed Shape"
        following={following}
        drifted={drifted}
        hasVideo
        videoOpen={videoOpen}
        cacheState={cached ? { status: "cached" } : { status: "none" }}
        onTogglePlay={() => setPlaying((p) => !p)}
        onSeek={setPosition}
        onSkip={(delta) => setPosition((p) => Math.max(0, p + delta))}
        onSpeedChange={setSpeed}
        onToggleFollow={() => {
          setDrifted(false);
          setFollowing((f) => !f);
        }}
        onJumpToCurrent={() => setDrifted(false)}
        onToggleVideo={() => setVideoOpen((v) => !v)}
        onToggleCache={() => setCached((c) => !c)}
      />
      <div className="w-[220px]">
        <NowPlayingBar
          title="Ilya Sutskever — Scaling"
          subtitle="Dwarkesh Podcast"
          playing={playing}
          positionSec={position}
          durationSec={6130}
          onTogglePlay={() => setPlaying((p) => !p)}
          onOpen={() => setDrifted(false)}
          onClose={() => setPlaying(false)}
        />
      </div>
      <p className="text-[12.5px] text-label-2">
        State: {playing ? "playing" : "paused"} · {position}s · {speed}× · {drifted ? "drifted" : "locked"}
      </p>
    </div>
  );
}

export const ControlsAndKeyboard: Story = {
  render: () => <PlayerHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const player = canvas.getByRole("region", { name: "Media player" });

    // Play / Pause button toggles state
    await userEvent.click(within(player).getByRole("button", { name: "Play (k)" }));
    await expect(canvas.getByText(/State: playing/)).toBeInTheDocument();

    // Skip forward +30s
    await userEvent.click(within(player).getByRole("button", { name: "Forward 30 seconds (l)" }));
    await expect(canvas.getByText(/321s/)).toBeInTheDocument();

    // Jump back to current clears drifted state
    await userEvent.click(within(player).getByRole("button", { name: /Jump to 05:21/ }));
    await expect(canvas.getByText(/locked/)).toBeInTheDocument();

    // Playback speed menu via keyboard
    const speedBtn = within(player).getByRole("button", { name: "Playback speed: 1×" });
    speedBtn.focus();
    await userEvent.keyboard("{ArrowDown}");
    const menu = await body.findByRole("menu");
    await expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(6);
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "1.5×" }));
    await waitFor(() => expect(body.queryByRole("menu")).toBeNull());
    await expect(within(player).getByRole("button", { name: "Playback speed: 1.5×" })).toBeInTheDocument();

    // Collapsible video dock toggle
    await userEvent.click(within(player).getByRole("button", { name: "Show video (m)" }));
    const dock = canvas.getByRole("region", { name: "Companion video" });
    await expect(dock).toBeInTheDocument();
    await userEvent.click(within(dock).getByRole("button", { name: "Hide video (m)" }));
    await expect(canvas.queryByRole("region", { name: "Companion video" })).toBeNull();
  },
};
