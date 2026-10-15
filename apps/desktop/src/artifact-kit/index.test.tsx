// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Cite, DataTable, Figure, Stat } from "./index";

afterEach(cleanup);

const A = "0123456789abcdef";

describe("artifact kit", () => {
  it("reads a stat's change as positive or negative from its sign unless told", () => {
    render(<><Stat label="Gain" value="0.58" change="+0.17" /><Stat label="Loss" value="12" change="−3%" /><Stat label="Cost" value="180 ms" change="+40 ms" tone="negative" /></>);
    expect(screen.getByText("+0.17").getAttribute("data-tone")).toBe("positive");
    expect(screen.getByText("−3%").getAttribute("data-tone")).toBe("negative");
    expect(screen.getByText("+40 ms").getAttribute("data-tone")).toBe("negative");
  });

  it("cites a material by a link the frame opens at the quote", () => {
    render(<><Cite id={A} quote="from 0.41 to 0.58">a 17-point gain</Cite><Figure title="Gain" source={{ id: A, label: "On rerankers" }}>chart</Figure></>);
    const cite = screen.getByRole("link", { name: "a 17-point gain" });
    expect(cite.getAttribute("href")).toBe(`quire:material/${A}`);
    expect(cite.getAttribute("data-quote")).toBe("from 0.41 to 0.58");
    expect(screen.getByRole("link", { name: "On rerankers" }).getAttribute("href")).toBe(`quire:material/${A}`);
  });

  it("right-aligns number columns and sorts by a header click, descending first", () => {
    const rows = [{ change: "Chunking", gain: 5 }, { change: "Reranker", gain: 17 }, { change: "More k", gain: -4 }];
    render(<DataTable columns={[{ key: "change", label: "Change" }, { key: "gain", label: "Gain" }]} rows={rows} />);
    const firstColumn = () => [...document.querySelectorAll("tbody tr td:first-child")].map((cell) => cell.textContent);
    expect(document.querySelector("tbody td:last-child")?.getAttribute("data-align")).toBe("right");
    fireEvent.click(screen.getByRole("button", { name: /Gain/ }));
    expect(firstColumn()).toEqual(["Reranker", "Chunking", "More k"]);
    fireEvent.click(screen.getByRole("button", { name: /Gain/ }));
    expect(firstColumn()).toEqual(["More k", "Chunking", "Reranker"]);
    fireEvent.click(screen.getByRole("button", { name: /Gain/ }));
    expect(firstColumn()).toEqual(["Chunking", "Reranker", "More k"]);
  });
});
