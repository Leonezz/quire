// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../../shared/contracts";
import { deferred, flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { agentStore } from "./agentStore";
import { AgentPanel } from "./AgentPanel";
import { clearQuoteJumpReport, reportQuoteJump } from "./quoteJump";

/** A bridge that is available and empty, whose `agentAsk` the test settles by hand. */
function setup(agentAsk: () => Promise<AgentResult>) {
  api.read = mockRead({
    agentStatus: vi.fn(async () => ({ available: true, running: 0 })),
    listAgentRuns: vi.fn(async () => []),
    listAgentSessions: vi.fn(async () => []),
    getAgentSession: vi.fn(async () => undefined),
    listMaterials: vi.fn(async () => []),
    agentAsk: vi.fn(agentAsk),
  });
}

async function mountPanel() {
  await act(() => agentStore.start());
  render(<AgentPanel context={{ kind: "library" }} onOpenMaterial={() => undefined} onOpenLink={() => undefined} />);
  await act(flush);
}

afterEach(() => { cleanup(); agentStore.stop(); clearQuoteJumpReport(); vi.restoreAllMocks(); });

describe("AgentPanel", () => {
  it("says quietly when a citation's quoted passage was not found, until the next citation is pressed", async () => {
    setup(async () => ({ ok: true, sessionId: "s1", turnId: "t1" }));
    await mountPanel();
    expect(screen.queryByRole("status")).toBeNull();
    act(() => reportQuoteJump({ materialId: "526130b61f003c33", quote: "a passage that is not there", found: false }));
    expect(screen.getByRole("status").textContent).toBe("Opened; the quoted passage was not found");
    act(() => reportQuoteJump({ materialId: "526130b61f003c33", quote: "a passage that is there", found: true }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the question and Thinking… in the same commit as the quick action, before the bridge answers", async () => {
    const asked = deferred<AgentResult>();
    setup(() => asked.promise);
    await mountPanel();
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Brief recent" })); });
    // Asserted before the promise resolves.
    expect(screen.getByText("Summarise the library")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Thinking" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop (⌘.)" })).toBeTruthy();
    expect(api.read.agentAsk).toHaveBeenCalledTimes(1);
    await act(async () => { asked.resolve({ ok: true, sessionId: "s1", turnId: "t1" }); await flush(); });
    expect(screen.getByText("Summarise the library")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Thinking" })).toBeNull();
    expect(screen.getByRole("status", { name: "Answering" })).toBeTruthy();
  });

  it("clears the composer as soon as Send is pressed, and drops the bubble when the bridge refuses", async () => {
    const asked = deferred<AgentResult>();
    setup(() => asked.promise);
    await mountPanel();
    const field = screen.getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "why?" } });
    act(() => { fireEvent.keyDown(field, { key: "Enter" }); });
    expect(field.value).toBe("");
    expect(screen.getByText("why?")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Thinking" })).toBeTruthy();
    await act(async () => { asked.resolve({ ok: false, code: "TURN_RUNNING", message: "busy" }); await flush(); });
    expect(screen.queryByText("why?")).toBeNull();
    expect(screen.queryByRole("status", { name: "Thinking" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Still answering");
  });
});
