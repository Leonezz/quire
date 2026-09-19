# Quire

A quiet place to read everything you subscribe to.

Blogs, newsletters, papers, PDFs — whatever you bring in, Quire turns it into the same clean page, remembers where you were, keeps what you mark, and stays out of the way.

*A quire is a gathering of folded sheets, the unit a book is bound from.*

## What it does

**One reading surface for every source.** Paste a link or drop a file. Web articles are extracted and re-typeset: title, author, date, body, code, math, tables, figures, footnotes. PDFs open in a proper viewer with page thumbnails, search, and pinch zoom. Everything is stored locally, pictures included, so it reads the same offline.

**Typography you control once.** Typeface, size, measure, line height, light / paper / dark themes. Set it once and every material follows.

**Find your way through long pieces.** A contents rail runs beside the text: one tick per heading, the current one dark. Hover it to see where you are; press `t` to open the full outline. `⌘F` searches the page.

**Keep what matters.** Select any passage to highlight it in one of four colours, attach a note, or copy a citation with the title, author and link already filled in. Highlights work on PDFs too. Export everything you marked as Markdown.

**Honest about quality.** Quire tells you where the text came from and when an extraction is partial, and always offers the original.

**Subscribe, then decide.** Paste a feed, a site, or an arXiv category like `cs.CL`. New items land in an Inbox that asks one question per item: read it now (`↵`), queue it (`q`), or let it go (`e`). The Queue keeps what you saved in the order you want; Sources shows each subscription's health. `⌘K` finds anything by title.

**An agent that reads with you.** Press `⌘J` to ask about the article, a selected passage, or the whole library: explain, verify, find related material, summarise, or write a synthesis. Answers cite only the materials the agent actually opened, a synthesis is kept as its own artifact with its sources attached, and conversations stay with the material they are about (`⌘⇧J` lists them all). When a page came through garbled, ask the agent to rebuild it from the saved original. Runs on the Codex CLI signed in on your Mac.

**A library you can shape.** Every material carries Zotero-style metadata, read from the page (citation tags, JSON-LD, Open Graph, arXiv) and editable in the Info panel (`i`): type, creators, abstract, journal or site, identifiers, tags, related materials. Copy a citation or BibTeX, filter the Library by type or tag, search, delete in bulk. Every pane is resizable and remembers its size; `⌘,` opens Settings.

## Where it is going

- Inbox items suggested by the agent, and syntheses across everything you have read.
- Site-specific extraction profiles for the last stubborn layouts.

## Get it

Alpha builds for macOS are published at [github.com/Leonezz/quire-releases/releases](https://github.com/Leonezz/quire-releases/releases). The alpha is not yet signed: right-click the app and choose Open the first time. Quire checks for new alphas and offers them in Settings › About.

## Run it from source

```bash
pnpm install
pnpm dev
```

macOS first. Requires Node 22 and pnpm.

## Contributing

`pnpm typecheck && pnpm test` runs every suite. Design decisions live in `docs/adr/`, the roadmap in `docs/plan.md`.
