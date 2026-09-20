# Quire

A quiet place to read everything you subscribe to.

Blogs, newsletters, papers, PDFs — whatever you bring in, Quire turns it into the same clean page, remembers where you were, keeps what you mark, and stays out of the way.

*A quire is a gathering of folded sheets, the unit a book is bound from.*

![Quire reading a blog post, with the library on the left and the contents rail beside the text](docs/launch/screenshots/2-reader.png)

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

Alpha builds for macOS are published on the [Releases page](https://github.com/Leonezz/quire/releases): download the `.dmg` for your Mac (`arm64` for Apple silicon, `x64` for Intel) and drag Quire to Applications.

**First launch.** The alpha is signed with a development certificate, not notarized by Apple, so macOS will refuse to open it the normal way. Once:

1. Right-click (or Control-click) Quire in Applications and choose **Open**, then **Open** again in the dialog. If the dialog offers no Open button, go to **System Settings → Privacy & Security**, scroll to the message about Quire and click **Open Anyway**.
2. Or, in Terminal: `xattr -d com.apple.quarantine /Applications/Quire.app`.

After that it opens like any other app. Quire checks for newer alphas and offers them in **Settings › About**; installing in place works when the new build carries the same signature, otherwise it opens the download page.

The agent needs the [Codex CLI](https://github.com/openai/codex) installed and signed in (`codex login`); everything else works without it.

## Run it from source

```bash
pnpm install
pnpm dev
```

macOS first. Requires Node 22 and pnpm.

## Contributing

`pnpm typecheck && pnpm test` runs every suite. Design decisions live in `docs/adr/`, the roadmap in `docs/plan.md`.
