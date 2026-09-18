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

## Where it is going

- Feeds and arXiv subscriptions, with an inbox that answers one question per item: read it now, queue it, or let it go.
- An agent that works across what you read: explain a passage, check a claim, find related material, or write a synthesis with every quote traceable to its source.

## Run it

```bash
pnpm install
pnpm dev
```

macOS first. Requires Node 22 and pnpm.

## Contributing

`pnpm typecheck && pnpm test` runs every suite. Design decisions live in `docs/adr/`, the roadmap in `docs/plan.md`.
