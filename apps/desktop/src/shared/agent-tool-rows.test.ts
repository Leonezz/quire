import { describe, expect, it } from "vitest";
import { applyToolProgress, type ToolProgressEvent, type ToolRow } from "./agent-tool-rows";

const plain = (row: ToolRow): ToolRow => ({ ...row });
const apply = (rows: ToolRow[], ...events: ToolProgressEvent[]) => events.reduce((acc, event) => applyToolProgress(acc, event, plain), rows);
const read = (summary: string): ToolProgressEvent[] => [{ name: "material_read", status: "running" }, { name: "material_read", status: "done", summary }];

describe("applyToolProgress", () => {
  it("appends a running row and settles it in place", () => {
    expect(apply([], ...read("material_read a @0"))).toEqual([{ name: "material_read", status: "done", summary: "material_read a @0" }]);
  });

  it("keeps different calls as their own rows", () => {
    expect(apply([], ...read("a @0"), ...read("a @24000"))).toEqual([
      { name: "material_read", status: "done", summary: "a @0" },
      { name: "material_read", status: "done", summary: "a @24000" },
    ]);
  });

  it("folds a call that repeats the row before it into a count, so a loop stays one row", () => {
    const events = Array.from({ length: 5000 }, () => read("a @0")).flat();
    expect(apply([], ...events)).toEqual([{ name: "material_read", status: "done", summary: "a @0", count: 5000 }]);
  });

  it("does not fold across a different row or a different outcome", () => {
    const rows = apply([], ...read("a @0"), ...read("b @0"), ...read("a @0"), { name: "material_read", status: "running" }, { name: "material_read", status: "failed", summary: "a @0" });
    expect(rows.map((row) => [row.summary, row.status, row.count ?? 1])).toEqual([["a @0", "done", 1], ["b @0", "done", 1], ["a @0", "done", 1], ["a @0", "failed", 1]]);
  });

  it("folds past calls of other tools that are still running", () => {
    const rows = apply([], ...read("a @0"), { name: "library_search", status: "running" }, ...read("a @0"));
    expect(rows).toEqual([{ name: "material_read", status: "done", summary: "a @0", count: 2 }, { name: "library_search", status: "running" }]);
  });

  it("keeps the identity the caller gives a row when it is settled or folded", () => {
    let next = 0;
    const keyed = (row: ToolRow, previous?: ToolRow & { key: string }) => ({ ...row, key: previous?.key ?? `k${next++}` });
    let rows: (ToolRow & { key: string })[] = [];
    for (const event of [...read("a @0"), ...read("a @0")]) rows = applyToolProgress(rows, event, keyed);
    expect(rows).toEqual([{ key: "k0", name: "material_read", status: "done", summary: "a @0", count: 2 }]);
  });
});
