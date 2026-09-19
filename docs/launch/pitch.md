# Quire alpha — launch copy

One line: **Quire is a quiet place to read everything you subscribe to — blogs, newsletters, papers, PDFs — with an agent that reads alongside you and never cites what it did not open.**

What to lead with (in this order): reading quality → the Inbox loop → the agent's honesty → local-first.

What not to claim: "AI summarises everything for you", "replaces your RSS reader today" (alpha), Windows/Linux (macOS only).

## Show HN

**Title:** Show HN: Quire – a reading app for blogs, papers and PDFs with an agent that cites only what it opened

**Body:**

I read a lot of blogs and arXiv papers and never liked the tools: RSS readers show you the feed's stub, read-later apps mangle code and math, and the "AI" features summarise things into mush and invent citations.

Quire is a macOS app (alpha) that does three things:

1. **Turns anything into the same clean page.** Paste a link, drop a PDF, or subscribe to a feed or an arXiv category. Web articles are re-extracted and re-typeset (code, math, tables, figures, footnotes); arXiv papers come with both the HTML rendering and the PDF, and you can switch. Everything is stored locally, pictures included.
2. **Asks one question per item.** New items land in an Inbox: read it now (↵), queue it (q), keep it (k) or let it go (e). Sources show their health. 100 items in five minutes, from the keyboard.
3. **An agent that reads with you.** ⌘J on an article, a selected passage, or the whole library: explain, verify, find related, summarise, or synthesise across materials. It runs on the Codex CLI on your Mac. The part I care about: it can only cite materials it actually retrieved in that turn — anything else renders as an unverified citation — and a synthesis is saved as an artifact with its sources attached. When a page came through garbled, you can ask it to rebuild the article from the saved original.

Also: Zotero-style metadata (types, creators, identifiers, BibTeX), highlights and notes on both pages and PDFs, resizable three-pane layout that stays out of the way.

Stack: Electron, React Aria, a hand-built extraction pipeline evaluated against 65 real blog snapshots, SQLite via node:sqlite. Alpha: macOS only, unsigned build for now (right-click → Open), expect rough edges.

Download: https://github.com/Leonezz/quire-releases/releases

I'd love to hear which sites it extracts badly.

## X / Twitter thread

1/ I built Quire, a macOS reading app for people who read blogs, newsletters and papers — and got tired of feed stubs, broken code blocks and AI that makes up citations. Alpha is out. 🧵

2/ Every source becomes the same page: paste a link, drop a PDF, subscribe to a feed or an arXiv category. arXiv papers come as HTML *and* PDF; switch with one key. Everything's stored locally, images included.

3/ The Inbox asks one question per item: read now (↵), queue (q), keep (k), let go (e). Sources show their health. It's designed so 100 unread items take five minutes.

4/ The agent (⌘J) explains, verifies, finds related material, summarises, synthesises. It can only cite what it actually opened in that turn — anything else shows as unverified. Syntheses are saved with their sources.

5/ Garbled page? Ask the agent to rebuild the article from the saved original. Highlights and notes work on pages and PDFs. Zotero-style metadata and BibTeX built in.

6/ macOS, unsigned alpha (right-click → Open). Runs on the Codex CLI for the agent part. Download + feedback: https://github.com/Leonezz/quire-releases/releases

## 中文（V2EX / 即刻 / 微博）

**标题：** 做了一个安静的阅读器 Quire：博客、通讯、论文、PDF 一套排版，Agent 只引用它真的打开过的材料（macOS alpha）

我平时读大量博客和 arXiv 论文，一直没有顺手的工具：RSS 阅读器只给 feed 摘要，稍后读应用会把代码块和公式搞坏，"AI 功能"把文章总结成糊，还会编引用。

Quire 做三件事：

1. **什么来源都变成同一张干净的页面。** 粘贴链接、拖入 PDF、订阅 feed 或 arXiv 分类。网页重新抽取、重新排版（代码、公式、表格、图、脚注）；arXiv 论文同时有 HTML 渲染和 PDF，一键切换。全部本地存储，图片也缓存。
2. **收件箱每条只问一个问题。** 现在读（↵）、排队（q）、收进库（k）、放过（e）。来源有健康度。100 条未读，键盘五分钟决定完。
3. **一个跟你一起读的 Agent。** ⌘J 对文章、选中的段落或整个库提问：解释、核查、找相关、总结、跨材料综合。跑在本机的 Codex CLI 上。我最在意的一点：它只能引用这一轮真正取过的材料，其他一律标为未验证；综合会存成带来源的 artifact。页面抽取坏了，可以让它从保留的原始页面重建。

另外：Zotero 式元数据（类型、作者、标识符、BibTeX）、网页和 PDF 上的划线批注、可拖拽的三栏布局。

技术：Electron + React Aria，自研抽取管线，用 65 篇真实博客快照做了评测集。目前 macOS，未签名 alpha（右键打开），会有毛边。

下载：https://github.com/Leonezz/quire-releases/releases
想听你们哪些站点抽取得不好。

## 截图清单（发布前补）

1. Inbox：左侧来源列表、按天分组的条目、右侧预览与三个按钮。
2. 阅读器：一篇带代码块和图的博客，目录刻度轨可见。
3. arXiv：工具栏 Web page | PDF 切换，PDF 视图。
4. Agent 面板：Related 的回答带引用 pill，其中一条未验证（虚线）。
5. Info 面板：期刊文章类型的字段与 Copy BibTeX。

## 发布节奏

- Day 0：GitHub Release `v0.1.0-alpha.1` + Show HN（美西早上 8–10 点）+ X 线程。
- Day 0 晚：V2EX / 即刻。
- 之后每周一个 alpha，release notes 只写用户可感知的变化；把 HN / 评论里报的站点加进评测集。
