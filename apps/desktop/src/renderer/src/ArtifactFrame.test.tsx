// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactFrame } from "./ArtifactFrame";

const ID = "0123456789abcdef";

afterEach(cleanup);

function setup() {
  const onOpenLink = vi.fn();
  const onOpenMaterial = vi.fn();
  render(<ArtifactFrame id={ID} version={2} title="Chart" onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} />);
  const frame = document.querySelector("iframe")!;
  const send = (data: unknown, source: MessageEventSource | null = frame.contentWindow) => act(() => { window.dispatchEvent(new MessageEvent("message", { data, source })); });
  return { frame, send, onOpenLink, onOpenMaterial };
}

describe("ArtifactFrame", () => {
  it("loads the artifact in a scripts-only sandbox from its own scheme", () => {
    const { frame } = setup();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toMatch(new RegExp(`^quire-artifact://artifact/${ID}\\?v=2&scheme=(light|dark)$`));
  });

  it("takes the height the artifact reports, within bounds", () => {
    const { frame, send } = setup();
    send({ quire: 1, type: "size", height: 912.4 });
    expect(frame.style.height).toBe("913px");
    send({ quire: 1, type: "size", height: 10 });
    expect(frame.style.height).toBe("160px");
  });

  it("opens checked citations and web links, and ignores everything else", () => {
    const { send, onOpenLink, onOpenMaterial } = setup();
    send({ quire: 1, type: "open-material", id: ID, quote: "  the exact words  " });
    expect(onOpenMaterial).toHaveBeenLastCalledWith(ID, "the exact words");
    send({ quire: 1, type: "open-material", id: "../../etc" });
    send({ quire: 1, type: "open-link", url: "https://example.org/a" });
    send({ quire: 1, type: "open-link", url: "javascript:alert(1)" });
    send({ quire: 1, type: "open-link", url: "file:///etc/passwd" });
    // Another window (not this frame) cannot speak for the artifact.
    send({ quire: 1, type: "open-link", url: "https://evil.example" }, window);
    expect(onOpenMaterial).toHaveBeenCalledTimes(1);
    expect(onOpenLink.mock.calls).toEqual([["https://example.org/a"]]);
  });
});
