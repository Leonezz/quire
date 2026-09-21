import { describe, expect, it } from "vitest";
import { dominantColumns, layoutPage, placementOf } from "./columns";
import { column, line, pageOf } from "./testing";

const readingOrder = (page: ReturnType<typeof pageOf>) => layoutPage(page).bands.flatMap((band) => band.columns.flatMap((entries) => entries.map((entry) => entry.text)));

describe("layoutPage", () => {
  it("reads a two-column page left column first, then the right, under a full-width title band", () => {
    const left = column(72, 200, 220, 20, { text: (index) => `L${index + 1} text that fills the left column of the page` });
    const right = column(310, 200, 220, 20, { text: (index) => `R${index + 1} text that fills the right column of the page` });
    const page = pageOf([
      line({ text: "A Title Spanning the Whole Page Width Across Both Columns", x: 72, y: 80, w: 458, size: 14 }),
      line({ text: "Author One Author Two", x: 220, y: 110, w: 160, size: 12 }),
      ...right, ...left,
    ]);
    const layout = layoutPage(page);
    expect(layout.columns).toBe(2);
    expect(layout.bands.map((band) => band.kind)).toEqual(["full", "columns"]);
    const order = readingOrder(page);
    expect(order.slice(0, 2)).toEqual(["A Title Spanning the Whole Page Width Across Both Columns", "Author One Author Two"]);
    expect(order.slice(2, 22).every((text) => text.startsWith("L"))).toBe(true);
    expect(order.slice(22).every((text) => text.startsWith("R"))).toBe(true);
    expect(placementOf(layout).get(page.lines[1]!)).toBe("full");
  });

  it("keeps a single-column page with short paragraph endings as one column", () => {
    const page = pageOf([...column(72, 100, 450, 12), line({ text: "a short last line.", x: 72, y: 244, w: 90 }), ...column(72, 260, 450, 12), line({ text: "ends here.", x: 72, y: 404, w: 50 })]);
    expect(layoutPage(page).columns).toBe(1);
    expect(readingOrder(page)).toEqual(page.lines.map((entry) => entry.text));
  });

  it("still finds the gutter when the right column stops early", () => {
    const page = pageOf([...column(72, 100, 220, 40), ...column(310, 100, 220, 6)]);
    expect(layoutPage(page).columns).toBe(2);
  });

  it("puts a full-width figure caption between two column bands and reads the columns around it in order", () => {
    const page = pageOf([
      ...column(72, 100, 220, 5, { text: (index) => `top-left ${index}` }), ...column(310, 100, 220, 5, { text: (index) => `top-right ${index}` }),
      line({ text: "Figure 1: A wide figure caption that spans both columns of the page.", x: 72, y: 300, w: 458 }),
      ...column(72, 400, 220, 10, { text: (index) => `bottom-left ${index}` }), ...column(310, 400, 220, 10, { text: (index) => `bottom-right ${index}` }),
    ]);
    const layout = layoutPage(page);
    expect(layout.bands.map((band) => band.kind)).toEqual(["columns", "full", "columns"]);
    const order = readingOrder(page);
    expect(order.indexOf("top-right 0")).toBeGreaterThan(order.indexOf("top-left 4"));
    expect(order.indexOf("Figure 1: A wide figure caption that spans both columns of the page.")).toBeLessThan(order.indexOf("bottom-left 0"));
    expect(order.indexOf("bottom-right 0")).toBeGreaterThan(order.indexOf("bottom-left 9"));
  });
});

describe("dominantColumns", () => {
  it("takes the most common count over pages with enough text and defaults to one", () => {
    const two = layoutPage(pageOf([...column(72, 100, 220, 30), ...column(310, 100, 220, 30)]));
    const one = layoutPage(pageOf(column(72, 100, 450, 30)));
    const sparse = layoutPage(pageOf(column(72, 100, 450, 2)));
    expect(dominantColumns([two, two, one, sparse])).toBe(2);
    expect(dominantColumns([sparse])).toBe(1);
    expect(dominantColumns([])).toBe(1);
  });
});
