# Quire 首发 pitch（build in public 第 1 篇，2026-10-13）

一句话：**Quire 把博客、Newsletter、arXiv 论文和 PDF 变成同一张干净的页面。** 所有来源进同一个收件箱，在同一个阅读器里用同一套设置和笔记来读。

English: **Quire turns blogs, newsletters, arXiv papers and PDFs into one calm page.** One inbox for every source, one reader, one set of settings and notes.

## 讲什么，按这个顺序

1. **来源统一**：RSS、Substack 通讯、arXiv 分类、粘贴的链接、拖入的 PDF，全部进同一个收件箱，每条只问一个问题（↵ 现在读 · q 排队 · k 收进库 · e 放过）。
2. **样式统一**：任何网站进来后字体、字号、行距一样；代码、公式、表格、图、脚注重新排版；图片缓存到本地。
3. **阅读体验统一**：一套阅读设置（字体、字号、行宽、行距、Light / Paper / Dark）对所有材料生效；划线、笔记、复制引用在网页、PDF、Text 视图里一样用；arXiv 论文 Web 和 PDF 按 `v` 切换；双栏 PDF 可以读成单栏 Text 视图。

这次**不讲**：Agent（只在 HN 正文里带一句）、评测和 Jev。**不说**：开源（仓库公开但还没有 LICENSE）、已签名或开箱即用（开发证书签名，未公证）、"替代你的 RSS 阅读器"、Windows / Linux。

## 发帖前要处理的事

录素材时在真实应用里碰到的问题，按影响排序：

| 问题 | 影响 | 建议 |
|---|---|---|
| 收件箱列表有焦点时，`q` / `e` 被列表的首字母跳转吞掉，不排队也不放过；第一次决定后焦点回到列表，第二次必坏 | 第 4 张卡片和分拣动图展示的正是这组快捷键 | 发帖前修掉并发 alpha.4（已开后台任务） |
| 截图来自 `main`（0c5ea08），比 alpha.3 新：例如列表圆点的修复只在 `main` 上 | 用户下载 alpha.3 看到的和截图不完全一样 | 修完上一条后从 `main` 发 alpha.4 |
| 收件箱摘要段落之间缺空格（"works.Instead"、"CloudflareThe"） | 收件箱截图里能看到 | 修 gist 拼接 |
| 阮一峰周刊里 Cloudflare 邮箱混淆显示成 `[email protected]` | 已从封面换掉，正文卡片里看不到 | 抽取时解码 `data-cfemail` |
| 部分标题带站点后缀（"How to Fix Any Bug — overreacted"） | 对比图里能看到，问题不大 | 标题去站点名规则 |
| 新订阅首次同步的条目，来源名里的 HTML 实体没解码（`Lil&#39;Log`），下一次同步才正常 | 新用户第一眼就会看到 | 首次 upsert 用解码后的标题 |
| 仓库没有 LICENSE | HN 和 Reddit 一定会问 | 先定许可证，或在帖子里明说 "source available, license TBD" |

## 素材（`docs/launch/kit/`，只在本地，已写进 `.git/info/exclude`）

全部是真实应用截图：独立的演示数据目录，订阅了 7 个真实来源（阮一峰的网络日志、Lil'Log、overreacted、Ahead of AI、Simon Willison、Stratechery、arXiv cs.CL），导入了 BERT 论文 PDF。截图和录屏通过 Chrome DevTools 协议从应用渲染层直接取得；侧栏毛玻璃底色和红绿灯按原生截图的像素补回。"原站"对比图是 Playwright 截的原网页首屏（Stratechery 弹出了人机验证，所以对比图里没有它）。

| 文件 | 内容 | 用在哪 |
|---|---|---|
| `xiaohongshu/xhs-1.png` … `xhs-9.png` | 3:4 卡片，2160×2880 | 小红书图文，按顺序上传 |
| `x/x-1.png` … `x-4.png` | 16:9 横图，3200×1800 | X、Reddit、Product Hunt |
| `motion/quire-reel-zh.mp4` / `quire-reel-en.mp4` | 66 秒合集，带分段标题 | 小红书视频笔记 / X 置顶 |
| `motion/triage.*` | 收件箱分拣：↓ 浏览、q 排队、e 放过、k 收进库、↵ 阅读 | X 第 3 条、README |
| `motion/addlink.*` | ⌘N 粘贴 Paul Graham 文章链接，直接得到干净页面 | X 第 4 条 |
| `motion/bert.*` | BERT 双栏 PDF 切到 Text 视图并滚动 | X 第 5 条、README |
| `motion/arxiv.*` | arXiv 论文 Web page 和 PDF 来回切换 | 备用 |
| `motion/theme.*` | 阅读设置：Paper、New York 字体、Dark、回到 Light | X 第 6 条 |
| `source/` | 卡片的 HTML 源文件、所有截图和重新渲染脚本 | 改文案后执行 `node render.mjs xhs.html <outDir>` |

每段 `.mp4` 是 1920 宽，`.gif` 是 960 宽、12 fps。

## 小红书（图文，xhs-1 到 xhs-9）

**标题**（≤20 字，三选一）：

- 做了个阅读器：所有订阅读在一张干净的页面上
- 博客、Newsletter、论文、PDF，终于能一起读了
- 我给自己做了一个 Mac 阅读器

**正文**：

> 我每天要读的东西散在很多地方：几个技术博客、两三份 Substack 通讯、arXiv 的新论文，还有别人发来的 PDF。每个网站长得都不一样，弹窗、侧栏、赞助条、小字号，读久了很累。
>
> 所以我做了 Quire，一个 Mac 上的阅读器，只做一件事：把所有来源变成同一张干净的页面。
>
> 📥 来源统一：RSS、Substack、arXiv 分类、网页链接、本地 PDF，全部进同一个收件箱。每条只问一个问题：现在读、排队、收进库，还是放过。
>
> 📄 样式统一：不管原网站长什么样，进来以后字体、字号、行距都一样，代码、公式、图表重新排版，图片存到本地。
>
> 🎓 论文友好：arXiv 论文同时有网页版和 PDF，按 v 切换；双栏 PDF 可以读成单栏正文，划线两边同步。
>
> ✍️ 体验统一：一套阅读设置管所有材料，划线和笔记在网页和 PDF 上一样用，笔记能一键复制成 Markdown。
>
> 现在是免费 alpha，只支持 macOS，不用注册，数据都在本机。GitHub 搜 Leonezz/quire 就能下载。
>
> 我会在这里 build in public，记录做一个阅读器的全过程。你平时在哪些地方读东西？哪些网站的排版最让你头疼？留言告诉我，它们会直接进我的评测集。

**话题**：#效率工具 #Mac软件 #阅读 #RSS #Newsletter #论文阅读 #科研工具 #独立开发 #buildinpublic

**视频笔记**（可选，另发一条）：`motion/quire-reel-zh.mp4`，标题用"66 秒看完 Quire 怎么读"，正文用上面前两段。

## X / Twitter（7 条）

1/ I read blogs, newsletters, arXiv papers and PDFs every day, and every one of them looks different. So I'm building Quire: a macOS reader that turns all of them into one calm page. Free alpha, building in public 🧵 **[quire-reel-en.mp4]**

2/ Six sites, six layouts. In Quire, one: same type, same measure; code, math, tables and figures re-typeset; images kept locally. **[x-2.png]**

3/ One inbox for every source: RSS, Substack, arXiv categories, pasted links, dropped PDFs. Each item asks one question: read now (↵), queue (q), keep (k) or let go (e). **[triage.mp4]**

4/ Paste any link and get the clean page. **[addlink.mp4]**

5/ Papers: arXiv comes as HTML and PDF, switch with `v`. A two-column PDF can be read as a single-column Text view: headers and footers dropped, figures cropped from the page, highlights mirrored back to the PDF. **[bert.mp4]**

6/ One set of reading settings and one way to highlight and take notes, for every article, newsletter, paper and PDF. **[theme.mp4]**

7/ macOS only, free, everything stays on your Mac. Download: https://github.com/Leonezz/quire/releases. Tell me which sites come out broken; they go straight into my evaluation set. I'll post progress here every week.

## Reddit（r/macapps，flair 选 Free；r/rss 可以用同一篇）

**Title**: I built Quire, a Mac reader that turns blogs, newsletters, arXiv papers and PDFs into one clean page (free alpha)

**Gallery**: x-1, x-2, x-3, x-4（第一张图的说明写 "Inbox: seven sources in one list"）

**Body**:

> Hi r/macapps. I read a lot across very different places: personal blogs, a few Substack newsletters, arXiv, the occasional PDF someone sends me. Every source has its own layout, pop-ups and font sizes, so I built the reader I wanted.
>
> - **One inbox for every source.** RSS and Atom feeds, Substack, arXiv categories, pasted links and dropped PDFs. Triage from the keyboard: read now, queue, keep or dismiss.
> - **One page style.** Every article is re-extracted and re-typeset with the same typography: code blocks, math, tables, figures and footnotes included. Images are cached locally.
> - **Papers.** arXiv papers come with both HTML and PDF; press `v` to switch. Any PDF can also be read as a reflowed single-column Text view, and highlights carry over to the PDF.
> - **One reading setup.** Font, size, measure, spacing and Light / Paper / Dark apply everywhere. Highlights and notes work the same on pages and PDFs and copy out as Markdown.
>
> It's a free alpha for macOS (Apple silicon and Intel). It's signed with a development certificate but not notarized yet, so the first launch needs System Settings → Privacy & Security → Open Anyway. No account; everything is stored on your Mac.
>
> Download: https://github.com/Leonezz/quire/releases
>
> What I'd love to hear: sites that come out broken, and what you use today for reading feeds and papers.

## Show HN

**Title**: Show HN: Quire – one reader for blogs, newsletters, arXiv papers and PDFs

**Body**:

> I read across many sources every day: personal blogs, Substack newsletters, arXiv, PDFs. Each has its own layout, and switching between them is the tiring part, more than the reading itself. Quire is a macOS app that puts them all in one inbox and renders every item in the same reader.
>
> - Feeds, newsletters, arXiv categories, pasted links and PDFs all land in one inbox. You triage from the keyboard (read now, queue, keep, dismiss).
> - Every web page is re-extracted into one document model and re-typeset: code, math, tables, figures and footnotes. Images are cached so everything reads offline.
> - arXiv papers carry both the HTML rendering and the PDF; `v` switches. Any PDF gets a reflowed single-column Text view, built locally with rules: lines, columns, running headers and footers, headings, figure crops. Highlights are anchored per line, so they mirror between the Text view and the PDF.
> - One set of reading settings, highlights and notes across all of it.
>
> Extraction is the hard part, and I measure it in public: 66 real pages from blogs I read, scored by two model judges against a written rubric, with failures filed as GitHub issues. The current baseline is honest rather than flattering, and it is what I'm working down.
>
> There is also an optional agent that answers questions about what you're reading and only cites material it opened in that turn; it runs on your own Codex CLI login. It's not the point of this post.
>
> Stack: Electron, React Aria, SQLite via node:sqlite, pdf.js. macOS only, free alpha, development-signed but not notarized yet (first launch: Privacy & Security → Open Anyway).
>
> https://github.com/Leonezz/quire
>
> I'd especially like to hear which sites it extracts badly.

## 节奏

- Day 0：修完上面表格的前两行，发 alpha.4。
- Day 1：小红书图文（晚 8–10 点）；同一天 X 线程。
- Day 2：Show HN（美西早上 8–10 点）和 r/macapps。
- 之后每周一条 build in public 更新：本周修了哪些站点、评测集分数变化、一个新功能的动图。
