import { afterEach, describe, expect, it, vi } from "vitest";

const pdfjs = vi.hoisted(() => ({ task: undefined as undefined | { promise: Promise<unknown>; destroy: () => Promise<void> } }));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: { workerSrc: "pdf.worker.js" }, getDocument: () => pdfjs.task }));

import { findPdfQuote } from "./pdfQuoteSearch";

afterEach(() => { pdfjs.task = undefined; });

function openWith(promise: Promise<unknown>) {
  const task = { promise, destroy: vi.fn(async () => undefined) };
  pdfjs.task = task;
  return task;
}

const pageWith = (text: string) => ({ getTextContent: async () => ({ items: [{ str: text }] }) });

describe("findPdfQuote", () => {
  it("finds the page holding the quote and closes its own handle to the PDF", async () => {
    const task = openWith(Promise.resolve({ numPages: 2, getPage: async (page: number) => pageWith(page === 2 ? "The Quoted  passage." : "Other text") }));
    expect(await findPdfQuote("blob:paper", "quoted passage")).toEqual({ page: 2, occurrence: 0 });
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("closes the handle when the PDF cannot be opened, and reports why", async () => {
    const task = openWith(Promise.reject(new Error("Invalid PDF structure.")));
    await expect(findPdfQuote("blob:broken", "quoted passage")).rejects.toThrow("Invalid PDF structure.");
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });
});
