import { describe, expect, it } from "vitest";
import type { MaterialMeta } from "../../shared/contracts";
import { bibtexKeyOf, bibtexOf, escapeBibtex } from "../../shared/bibtex";

const journal: MaterialMeta = {
  kind: "journalArticle", title: "Calibrated Abstention for Long-Context QA",
  creators: [{ role: "author", name: "Mara Lindqvist", given: "Mara", family: "Lindqvist" }, { role: "author", name: "Tomasz Nowak" }, { role: "editor", name: "E. Ditor" }],
  publication: "Journal of Retrieval", volume: "12", issue: "3", pages: "201-219", date: "2026-05-12", doi: "10.1234/jr.2026.0042", issn: "1234-5678",
  url: "https://journal.example.test/articles/42", accessed: "2026-09-18T12:00:00.000Z",
};

describe("bibtexOf", () => {
  it("writes a journal article with structured and display names, a double-braced title, month macro and page range", () => {
    expect(bibtexOf(journal, "fallback")).toBe([
      "@article{lindqvist2026calibrated,",
      "  author = {Lindqvist, Mara and Tomasz Nowak},",
      "  editor = {E. Ditor},",
      "  title = {{Calibrated Abstention for Long-Context QA}},",
      "  journal = {Journal of Retrieval},",
      "  volume = {12},",
      "  number = {3},",
      "  pages = {201--219},",
      "  issn = {1234-5678},",
      "  year = {2026},",
      "  month = may,",
      "  doi = {10.1234/jr.2026.0042},",
      "  url = {https://journal.example.test/articles/42},",
      "  urldate = {2026-09-18}",
      "}",
    ].join("\n"));
  });

  it("writes a preprint as misc with the arXiv eprint fields and the primary class from the extra line", () => {
    const meta: MaterialMeta = { kind: "preprint", title: "Retrieval Without Regret", creators: [{ role: "author", name: "Mara Lindqvist" }], arxivId: "2409.12345", extra: "arXiv: 2409.12345 [cs.CL]", date: "2026-09-17T17:59:12.000Z", publication: "arXiv", url: "https://arxiv.org/abs/2409.12345", accessed: "2026-09-18T12:00:00.000Z" };
    expect(bibtexOf(meta, "x")).toBe([
      "@misc{lindqvist2026retrieval,",
      "  author = {Mara Lindqvist},",
      "  title = {{Retrieval Without Regret}},",
      "  eprint = {2409.12345},",
      "  archivePrefix = {arXiv},",
      "  primaryClass = {cs.CL},",
      "  year = {2026},",
      "  month = sep,",
      "  url = {https://arxiv.org/abs/2409.12345},",
      "  urldate = {2026-09-18}",
      "}",
    ].join("\n"));
  });

  it("writes a web page as misc with howpublished, an accessed note, and escapes what LaTeX would read as markup", () => {
    const meta: MaterialMeta = { kind: "blogPost", title: "Cache keys & 100% {hits} #1_a $x", publication: "Systems Notes", date: "2026-09", url: "https://systems.example.test/posts/cache_keys?a=1&b=2", accessed: "2026-09-18T12:00:00.000Z" };
    expect(bibtexOf(meta, "x")).toBe([
      "@misc{cache2026,",
      "  title = {{Cache keys \\& 100\\% \\{hits\\} \\#1\\_a \\$x}},",
      "  howpublished = {\\url{https://systems.example.test/posts/cache_keys?a=1&b=2}},",
      "  year = {2026},",
      "  month = sep,",
      "  url = {https://systems.example.test/posts/cache\\_keys?a=1\\&b=2},",
      "  urldate = {2026-09-18},",
      "  note = {Accessed 2026-09-18}",
      "}",
    ].join("\n"));
  });

  it("maps the other kinds to their entry types and falls back to the id for a key when nothing names the entry", () => {
    expect(bibtexOf({ kind: "conferencePaper", title: "T", publication: "Proc. X", publisher: "ACM", place: "Vienna" }, "x")).toMatch(/^@inproceedings\{t,\n {2}title = \{\{T\}\},\n {2}booktitle = \{Proc\. X\},\n {2}publisher = \{ACM\},\n {2}address = \{Vienna\}\n\}$/);
    expect(bibtexOf({ kind: "book", publisher: "P" }, "0123456789abcdef")).toBe("@book{0123456789abcdef,\n  publisher = {P}\n}");
    expect(bibtexOf({ kind: "bookSection" }, "x").startsWith("@incollection{")).toBe(true);
    expect(bibtexOf({ kind: "report", publisher: "Institute" }, "x")).toContain("institution = {Institute}");
    expect(bibtexOf({ kind: "thesis", publisher: "University" }, "x")).toMatch(/^@phdthesis\{.*school = \{University\}/s);
    expect(bibtexOf({}, "x")).toBe("@misc{x,\n\n}");
    expect(bibtexKeyOf({ title: "Éclair naïve", date: "2024" }, "x")).toBe("eclair2024");
    expect(escapeBibtex("a_b")).toBe("a\\_b");
  });
});

describe("bibtexKeyOf with non-ASCII names", () => {
  it("falls back to the material id instead of a bare year", () => {
    expect(bibtexKeyOf({ title: "科技爱好者周刊", creators: [{ role: "author", name: "阮一峰" }], date: "2026-09-18" }, "9d96ad715e20ddf7")).toBe("9d96ad715e20ddf72026");
  });
});
