// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaterialSummary } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { ArtifactSurface } from "./ArtifactCitations";

const A = "0123456789abcdef";
const B = "fedcba9876543210";
const GONE = "deadbeefdeadbeef";

const summary = (id: string, title: string, extra: Partial<MaterialSummary> = {}) => ({ id, title, url: `https://example.org/${id}`, origin: "web", ...extra }) as MaterialSummary;

const markdown = `The fox, as one essay has it, "the quick brown fox jumps over" [${A}]. Both agree [${A}, ${B}]; a third does not [${GONE}].`;
// The reader document saveArtifact builds from that Markdown: the ids stay in the text.
const payload = { type: "root", losses: [], children: [{ type: "paragraph", children: [{ type: "text", value: markdown }] }] };

afterEach(cleanup);

async function setup() {
  api.read = mockRead({ listMaterials: vi.fn(async () => [summary(A, "On Foxes", { byline: "Ann Author", publication: "Fox Quarterly" }), summary(B, "Dogs, Lazily")]) });
  const onOpenMaterial = vi.fn();
  render(<ArtifactSurface material={{ lineage: [A, B] }} markdown={markdown} onOpenMaterial={onOpenMaterial} schema="reader.document.v2" payload={payload} fallback={{ content: markdown, format: "gfm" }} />);
  await flush();
  return { onOpenMaterial };
}

describe("ArtifactSurface", () => {
  it("shows numbered reference marks in place of the raw ids", async () => {
    await setup();
    const paragraph = document.querySelector("p")!;
    expect(paragraph.textContent).not.toContain(A);
    expect(paragraph.textContent).toBe(`The fox, as one essay has it, \u201Cthe quick brown fox jumps over\u201D[1]. Both agree[1, 2]; a third does not[3].`);
    expect(screen.getAllByRole("button", { name: "Source 1: On Foxes" })).toHaveLength(2);
  });

  it("opens the cited material at the quoted passage", async () => {
    const { onOpenMaterial } = await setup();
    const [quoted, plain] = screen.getAllByRole("button", { name: "Source 1: On Foxes" });
    fireEvent.click(quoted!);
    expect(onOpenMaterial).toHaveBeenLastCalledWith(A, "the quick brown fox jumps over");
    fireEvent.click(plain!);
    expect(onOpenMaterial).toHaveBeenLastCalledWith(A);
  });

  it("marks a citation the agent never listed, or that left the library, as unverified", async () => {
    await setup();
    const gone = screen.getByRole("button", { name: /^Source 3: Material deadbeef \(no longer in the library\) \(unverified citation\)$/ });
    expect(gone.getAttribute("data-unverified")).toBe("true");
    expect(screen.getByRole("button", { name: "Source 2: Dogs, Lazily" }).getAttribute("data-unverified")).toBeNull();
  });

  it("lists the sources after the text with their titles and details", async () => {
    const { onOpenMaterial } = await setup();
    const list = screen.getByRole("region", { name: "Sources" });
    const items = [...list.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual([
      "[1]On FoxesAnn Author · Fox Quarterly",
      "[2]Dogs, Lazilyexample.org",
      "[3]Material deadbeef (no longer in the library)not among the sources the agent read",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Dogs, Lazily" }));
    expect(onOpenMaterial).toHaveBeenLastCalledWith(B);
  });
});
