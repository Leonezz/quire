// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";

const api = vi.hoisted(() => ({ getArtifactVersion: vi.fn(), restoreArtifactVersion: vi.fn() }));
vi.mock("./api", () => ({ read: api }));
const { ArtifactVersionBar, useArtifactVersions } = await import("./ArtifactVersions");

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ID = "0123456789abcdef";
const content = (version: number) => ({ view: "artifact", artifactBody: { type: "react", source: `v${version}`, version } }) as unknown as MaterialViewContent;
const material = { id: ID, origin: "agent", artifact: { type: "react", version: 3, updatedAt: "2026-10-14T00:00:00Z" } } as MaterialRecord;

function Harness({ onSaved }: { onSaved: (record: MaterialRecord) => void }) {
  const versions = useArtifactVersions(material, content(3), onSaved);
  return <><ArtifactVersionBar versions={versions} /><p data-testid="body">{versions.content.artifactBody?.source}</p></>;
}

describe("artifact versions", () => {
  it("steps back to an earlier version, shows it, and restores it", async () => {
    api.getArtifactVersion.mockImplementation(async (_id: string, version: number) => content(version));
    api.restoreArtifactVersion.mockResolvedValue({ ...material, artifact: { ...material.artifact, version: 4 } });
    const onSaved = vi.fn();
    const view = render(<Harness onSaved={onSaved} />);
    expect(view.getByText("Version 3 of 3")).toBeTruthy();
    act(() => { view.getByRole("button", { name: "Earlier version" }).click(); });
    await waitFor(() => expect(view.getByTestId("body").textContent).toBe("v2"));
    expect(api.getArtifactVersion).toHaveBeenCalledWith(ID, 2);
    expect(view.getByText("Version 2 of 3")).toBeTruthy();
    await act(async () => { view.getByRole("button", { name: /Restore this version/ }).click(); });
    expect(api.restoreArtifactVersion).toHaveBeenCalledWith(ID, 2);
    expect(onSaved).toHaveBeenCalled();
    expect(view.getByTestId("body").textContent).toBe("v3");
  });
});
