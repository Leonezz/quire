# Quire 落地计划（2026-09-17 起）

北极星：每周被读完的材料数。范围与合同见研究仓库的 `reading-first-mvp-scope-and-plan.md`，本文件只记录"接下来按什么顺序做、做到什么算完"。每一刀独立可用、独立提交。

## 现状对照阅读合同

| 合同 | 状态（2026-09-17） |
|---|---|
| R1 一键进入、本地缓存、离线可读 | 已有（URL / 文件 → JSON 落盘） |
| R2 同一套排版 | 网页、Markdown、PDF 已有 |
| R3 阅读控制全局记忆 | 已有（缺"纸"主题） |
| R4 目录、进度、页内搜索 | 已有 |
| R5 阅读位置记忆 | HTML 与 PDF 已有 |
| R6 来源与质量透明 | 头部质量标签 + 低质量横幅与打开原文；feed 副本回退带 `FEED_CONTENT_FALLBACK` 标记 |
| R7 安全 | CSP 已启用；图片由主进程缓存后以 data URL 交付 |
| R8 不静默降级 | 错误走 Add 面板；阅读页内有低质量 / 纯文本横幅 |

## 步骤

### 第 1 刀：PDF 阅读器（R2 / R5）— 已完成 2026-09-17
- `packages/reader-pdf`：从研究仓库剥离注解后的查看器（连续页、缩放、旋转、缩略图、目录、页内搜索、导航历史、阅读状态记忆），33 个测试；worker 用 `?url` 导入，同源加载。
- 主进程 `engine/pdf.ts`：pdf.js 在 Node 里读页数、Info 字典、首三页文本；Info 无标题时取首页最大字号的正立文本作标题（arXiv 需要）。字节落盘 `<id>.pdf`，`material:bytes` IPC 取回，渲染端转 blob URL；CSP 放行 `connect-src blob:`。
- 拖入 PDF / 粘贴 arXiv PDF 链接即读；页位置与侧栏状态按材料记忆；阅读视图外加 ErrorBoundary，单个表面失败不再白屏。
- 已验：真实 arXiv PDF 解析 292 ms；浏览器预览与桌面 app 均通过；关闭再开回到原页。
- 补充（同日）：目录统一为刻度轨 `TocRail`（`@read/ui`，文章与 PDF 共用：一条刻度一个标题，当前段深色加长，悬停 / 聚焦 / `t` 展开标签，方向键可走）；PDF 双指缩放（ctrl+wheel）与 ⌘= / ⌘- / ⌘0，缩放锚定当前页位置；PDF 目录改为数据输出（`onOutlineChange`），侧栏只剩缩略图。
- 未做（推后）：PDF 页面反色的暗色模式；标注（第 3 刀）。

### 第 2 刀：评测集（博客部分）与质量档位（R6 / R8）— 已完成 2026-09-18
- `eval/`：64 篇真实博客快照（`corpus.json` + `corpus/<slug>/page.html.gz`，gzip 后 6 MB），覆盖 Substack、Ghost、WordPress、Medium、Hugo、Jekyll、Quarto、Next.js、Movable Type 等；`pnpm --filter @read/eval fetch` 抓取，`pnpm --filter @read/eval eval` 跑全量并写 `eval/report.md`，`GOLDEN=1` 写缺失 golden、`GOLDEN=all` 重写。每篇一个 `expected.json`（结构摘要 + `reviewed` + `notes`），已全部人工审过一遍。
- 首轮 58% → 100%（64/64，门槛 85%）。修掉的根因：预解析扫描器把多余闭合标签当超预算；没有唯一 `<article>` 根时根本不跑抽取器；"富结构保留率"拿整页导航去比正文。新增：JSON-LD / URL / 可见署名的日期作者补全；标题选择（站名、后缀、锚点符号、h2 回退）；无 `<pre>` 的多行 `<code>` 识别为代码块；`<br><br>` 分段；页内目录与尾部 related / share / newsletter 块的通用剪除（记入 `rulesApplied`）。
- 阅读页：低质量横幅（抽取器分歧 / 仅摘要）带"打开原文"；纯文本降级横幅同样带链接。
- 独立评审（Sonnet 子代理，`eval/quality-review.md`，2026-09-18）：36 通过 / 6 轻微 / 22 严重。按其前十项修复：正文重复标题（改为在 DOM 层删除并把其余 h1 降为 h2）、标题里的锚点符号与整标题链接、尾部相关文章 / 作者卡片 / 推广块与首部元信息行（`article-prune.ts` 展平包装层后按链接密度、推广词、日期署名行识别）、`<font>` + `<br><br>` 的段落、`\[…\]` 行内公式、站名 / UI 文字混进标题、中文日期、正文里的署名、`<pre>` 上的语言类名、无 `<pre>` 代码块的 Markdown 表示。
- 已知残留（写在各篇 notes 里）：个别站点的元信息行 / 上下篇链接 / 语言切换列表；`<d-footnote>` 内联脚注未支持；这些留给 L3 站点 profile。
- 未做（推后）：feed 摘要的"获取完整正文"动作属于 M1 来源接入。

### 第 3 刀：沉淀最小闭环（§2.3）— 已完成 2026-09-18
- 划线 + 批注：文章用 text-quote 锚定并以 CSS Custom Highlight 绘制；PDF 用 pdf-regions 锚定并在页面上画区域。选中即出浮动条（四色 / 加批注 / 复制引用）；Notes 面板列出、跳转、内联编辑、删除、复制单条引用或全部导出 Markdown。存储在 `userData/annotations/<material>.json`；浏览器预览用 localStorage。
- 原设计要点：
- 划线 + 一句批注，锚定到 text-quote（HTML）或页 + 区域（PDF）；Notes 面板列出并可跳转。
- 一键复制引用（引文 + 标题 + 作者 + 链接 + 位置）；标注导出 Markdown。
- 验收：关闭再开标注仍在原位；复制的引用可粘到 Obsidian 直接用。

### 第 4 刀：安全与离线收尾（R7）— 已完成 2026-09-18
- 图片由主进程抓取一次、落盘 `userData/images`，以 data URL 交给阅读器（CSP 不放行远程主机）；纸色主题；净化 fixture 见 normalize 测试。
- 原设计要点：
- 图片本地缓存（内容寻址），无网时图片仍显示；净化 HTML 的 fixture 补齐。
- 纸色主题。
- 到此 M0 完成，打 tag。

### 第 5 刀：M1 来源与列表 — 已完成 2026-09-19（`9132c12`）
- 主进程：`node:sqlite` 落库（`userData/quire.sqlite`：sources / items / reading_events，`user_version` 迁移）；RSS / Atom 走 `normalizeFeedCapture`，arXiv 类别走 export API 的 Atom；`sync.ts` 记录健康度（最近成功 / 最近错误 / 连续失败数 / 暂停），`scheduler.ts` 每 15 分钟跑一次到期来源，手动 Sync 与调度共用一次运行；Read now 先取原页（arXiv：HTML 渲染，再 PDF），失败且 feed 带全文时才用 feed 副本并以 `FEED_CONTENT_FALLBACK` 标记。阅读时长按 CJK 字符计。
- 渲染端：Inbox 按日 / 按来源分组，Enter / q / e 三键，右栏预览即阅读（内嵌阅读器，Esc 返回）；Queue 分"继续 / 接下来"，键盘与拖拽排序；Sources 健康度、Sync now、Pause、Disconnect；Add 面板识别 feed / 站点 alternate link / arXiv 类别；⌘K 搜索标题与署名（库 + 收件箱）；阅读进度 ≥ 95% 记 finished 事件并盖到条目上。浏览器预览用 localStorage 种子数据。
- 已验：桌面 app 订阅阮一峰 Atom（3 条）与 arXiv cs.CL（50 条），Read now 落库并内嵌打开，q 入队，Sync now 显示 +0 new，⌘K 命中库与收件箱。
- 未做（推后）：OPML 导入；空格预览；100 篇评测集扩容（arXiv HTML / PDF 样本）留给 L3。

### 第 6 刀：M2 Agent — 首刀完成 2026-09-19（`25c1549`）
- 主进程 `engine/codex-client.ts`：`codex app-server` 的 stdio JSON-RPC 客户端（initialize / account / thread / turn、流式 delta、`item/tool/call` 动态工具、interrupt、10 分钟超时、进程退出重启），只读 sandbox，审批一律拒绝；`agent-tools.ts` 七个库内工具（search / recent / read 分页 / annotations / inbox / import / artifact_write 带 lineage）；`agent.ts` 按上下文（Library / 材料 / 选区）拼前言，任务模板 explain / verify / related / summary / synthesis。协议细节已对 codex 0.144.1 实测（`dynamicTools` 需 `type:"function"`）。
- 渲染端 `AgentPanel`：阅读器与外壳共用；上下文 pill、快捷动作、流式 Markdown 转录（工具行、`[材料 id]` 引用 pill 可打开来源）、多行输入、⌘. 停止、登录引导；选区浮动条加 Ask；agent 写的 artifact 以 origin `agent` 入库，Library 行标 artifact，阅读头部列出 lineage。
- 已验：桌面 app 对阮一峰一期周刊 Summarise 与 Related，后者调用 library_search 引用了 7 篇库内材料。
- 未做（推后）：MCP server 形态（现用实验性 dynamicTools）；artifact skills 移植；多文档综合的验收样例；面板关闭即丢转录（线程 id 可续，但未持久化）。

### 第 7 刀：M3 元数据、库管理、设置、会话、重建 — 已完成 2026-09-19（`1eaa6f9` `8b50586` `f8e4a08`）
- 独立评审（Sonnet，`eval/quality-review-m1-m2.md`）：7 个领域 4 MAJOR / 1 PASS / 1 MINOR；前十项已全部修复：CJK 标点不再算词、turn id 未到前按 Stop 会延后生效、定时 / 全量 / 单源同步共用一把锁、artifact lineage 与引用 pill 只接受本轮真正取过的材料 id（`sources` 随 completed 事件与会话轮次落库，schema v3）、⌘K 与 library_search 搜正文、决定错误按条目作用域、Queue 排序请求代际保护、上下文 pill 用真实标题、Library 无选中时 ⌘J 可用、Disconnect 失败在确认层内可见、agent 失败按码区分并可重试、渲染层首批 26 个测试。
- 元数据：`material_meta` 覆盖层（标题 / 作者 / 日期 / 标签 / 备注），阅读器 Info 面板（`i`）编辑并可重置；Library 行显示标签 chips。
- 库管理：`queryLibrary`（类型 / 标签 / 排序 / 标题搜索）、多选删除（级联删记录、字节、批注、元数据，条目解除链接）、Inbox / Queue 的 Keep（`k`，不标已读入库）。
- 设置（⌘,）：`userData/settings.json` — 同步间隔（调度实时生效）、保留原始页面、Codex 路径 / 模型 / 推理强度（`turn/start` 的 `model` / `effort`）、数据目录、快捷键表；阅读设置与 Aa 弹层共用一份状态。
- 布局：`SplitPane`（react-resizable-panels）侧栏 / 列表 / 检查器可拖拽与键盘调整并按像素记忆，`⌘\` 收起侧栏；无作用元素走查：Toggle sidebar 变真、外壳检查器占位 tab 删除、占位文案换成真实 agent 状态。
- Agent：会话落库（`agent_sessions` / `agent_turns`），面板重开恢复转录，History / New conversation，全局 Agent 视图（⌘⇧J）；对无法稳定解析的页面，"Rebuild with the agent"让 agent 通过 `material_source` 分页读取保留的原始页面（linkedom 转结构化文本），写出忠实的 Markdown artifact 并以 `rebuiltAs` 回链（已用阮一峰 411 期实测：标题 / 作者 / 日期 / 章节 / 图片完整）。
- 未做（推后）：Info 面板显示"原始值"需要合同暴露抽取值；agent 向 Inbox 推荐条目（introducedBy）；多文档综合的验收样例；OPML。

### 第 8 刀：Zotero 式元数据 — 已完成 2026-09-19
- 模型（`contracts.ts`）：13 种条目类型（webpage / blogPost / newsletter / newsArticle / journalArticle / preprint / conferencePaper / book / bookSection / report / thesis / document / note），创建者带角色（author / editor / translator / contributor）与结构化姓名，摘要、出版物 / 卷 / 期 / 页 / 出版者 / 地点 / 版次 / 丛书、日期（允许 YYYY / YYYY-MM）、访问日期、语言、DOI / arXiv / ISBN / ISSN / URL、标签、备注、extra、关联材料；`MATERIAL_KIND_FIELDS` 决定每种类型显示哪些字段。三层：`extracted`（来源声明，不可编辑）→ `overrides`（用户）→ `meta`（生效），顶层 title / byline / publishedAt / kind / publication 由 meta 派生。
- 引擎：`metadata-sources.ts` + `metadata.ts` 按 Highwire `citation_*` → Dublin Core → JSON-LD → Open Graph → `<meta author>` / `<html lang>` → arXiv id → 条目自带元数据（Atom 作者 / 摘要 / 分类）→ 抽取器回退的优先级合并；类型推断；schema v4（`material_meta.overrides` JSON、`items.meta`）；`refreshMetadata` 从保留的原始页面重抽；`shared/bibtex.ts` 纯函数导出 BibTeX（CJK 作者名回退到材料 id 作 key）；agent 工具结果带 kind / creators / publication / doi / arxivId。
- UI：Info 面板重做（类型菜单、创建者编辑器可排序、按类型显示字段、标识符可打开、关联材料选择器、每字段"extracted: … · Reset"、Copy citation / Copy BibTeX / Refresh from source、About 折叠）；Library 行显示类型与出版物、Type 过滤、批量 Copy BibTeX；阅读头部显示创建者 · 出版物 · 日期；引用与批注导出用新模型。同时修了：Library 工具栏回到列表列（阅读器标题栏占顶行）、侧栏收起时的红绿灯槽、分栏缝隙、artifact 重复标题、专注模式下显式打开面板会退出专注。
- 未做（推后）：Crossref / arXiv API 按 DOI / id 补全元数据；CSL 样式引用；OPML。

### 第 9 刀：布局重设计 — 已完成 2026-09-19（设计见 `docs/design/layout.md`）
- 调研 Mail / Notes / Reeder / NetNewsWire / Readwise Reader / Zotero 7 后定下三条规则：三栏平铺一条工具栏；切面进侧栏、列表只做列表；面板开关只在工具栏。
- 实现：去掉玻璃卡片与缝隙，侧栏走系统 vibrancy，1px 分隔线即拖拽柄；红绿灯落在侧栏 52px 头部，侧栏收起时工具栏向左延伸并留 80px 内缩；侧栏 = Inbox / Queue / Agent + Library（All / Articles / Papers / Artifacts）+ Tags（前 8 个 + All tags…）+ Sources（健康点 + 未读数，点即该来源的 Inbox；Manage sources… 进管理）+ Settings；Library 过滤栏与 Inbox 的 Date / Source 分段整体删除，列表只剩搜索与排序；检查器去掉 tab 条，只有名称 + ×，由阅读器工具栏的 Info / Notes / Ask 互斥切换。
- 未做（推后）：无材料打开时工具栏没有 Ask 按钮（⌘J 仍可用）；窄窗口三栏 + 面板同时打开时低于各自最小宽度。

### 第 10 刀：Agent 运行时 — 已完成 2026-09-19（设计见 `docs/design/agent-runtime.md`，`16a0484`）
- 问题：turn 的实时状态住在面板 hook 里，切走视图即丢；主进程里其实还在跑。
- 标准做法（VS Code Copilot Chat 的 ChatService / ChatModel、Zed 的 ThreadStore、Cursor / Claude Code 的后台会话、Codex app-server 的 thread 模型）：运行状态在视图之外，事件可重放，视图只订阅，多个运行并行，完成时通知。
- 实现：`agentAsk` 立即返回 `{ sessionId, turnId }`；事件全部带 `sessionId`；主进程 `runs` 注册表 + `listAgentRuns()` 快照；CodexClient 按 thread 维护多个 turn（`TURN_RUNNING` 只针对同一会话）；`agentInterrupt(sessionId)`；退出时进行中的 turn 记为 interrupted；窗口未聚焦时完成 / 失败发系统通知并可点开会话。渲染层 `agentStore`（useSyncExternalStore）启动取快照后跟事件，面板成为纯视图；侧栏 Agent 条目显示运行中数量，Agent 视图把运行中的会话排前。
- 已验（桌面 app 真实 turn）：提问后立刻切到 Inbox，侧栏显示 Agent 1（转圈），Agent 视图列出"answering…"，切回后继续显示；主进程 223 个测试（含并行线程、按会话中断、退出孤儿）。

### 第 11 刀：多视图、图标标尺、即时气泡 — 已完成 2026-09-19（`119188e` + 后续提交）
- 多视图：一个材料可有 web / pdf / markdown 多个渲染（`views` 带 ready / available / failed 状态，`primaryView`），非主视图存在 `<id>.<view>.json`（PDF 另有 `<id>.<view>.pdf`）；arXiv 读取时 HTML 作主视图、PDF 登记为可按需获取（HTML 404 时反之）；批注带 `view`，Notes 按视图分组、跨视图跳转先切视图；阅读器工具栏 Segmented 切换（`v` 循环），Info › About 列出视图并可 Fetch / Retry / Make primary；Library 行显示 "Web + PDF"。实测：arXiv 论文 HTML 主视图 + 按需取 PDF（25 页），切换正常。
- 图标：根因是尺寸在每个调用点各自写死（12–16px）且原语本身把图标缩到 14px，lucide 的 24 格描边 2 在 12–14px 下又小又细。根治：tokens `--icon-sm/md/lg`（14/18/22）+ 1.75 非缩放描边，`Icon` 原语与各原语的 slot 规则接管尺寸，删除全部调用点尺寸类，`icon-scale.test.ts` 守卫扫描源码防回退；顺带修了 icon-only Button 被 padding 顺序挤压的问题。
- Agent 快捷按钮：`ask()` 按下即在 store 里同步建 pending run，气泡与"Thinking…"当帧出现，输入框立即清空，`agentAsk` 返回后重绑真实 sessionId（先到的事件合并）。
- 推后：普通网页的 `citation_pdf_url` 登记为 PDF 视图（metadata-sources 尚未解析该标签）；重新打开已在库中的 URL 会重置为单视图。

### 第 12 刀：发布准备 — 已完成 2026-09-20
- 打包：electron-builder 26（`apps/desktop/electron-builder.yml`），pnpm 外部依赖按 allow-list 打进 asar（62 MB），`extraMetadata.productName` 让打包版用独立的数据目录；图标 `build/icon.svg` → icns；本地 `package:dir` 与 dmg 均通过，未签名版可启动。
- CI：`.github/workflows/ci.yml`（typecheck + 全部测试，含 Storybook 浏览器测试）；发布：`release.yml`（tag `v*` → macos-14 构建 → 发布到本仓库 Releases 的 prerelease，附 feat/fix 变更列表；有签名与公证密钥时自动签名公证）。流程见 `docs/release.md`。
- 更新：主进程 `UpdateService`（GitHub Releases API 手动检查，含 alpha 通道的 semver 比较）+ electron-updater 安装路径（仅签名构建可原地安装；未签名 macOS 构建只提供下载）；Settings › About 与侧栏横幅；`checkUpdatesAutomatically` 设置。
- 宣传文案：`docs/launch/pitch.md`（Show HN、X 线程、中文版、截图清单、节奏）。
- 2026-09-20 调整：`eval/corpus` 快照移出 git（本地保留，gitignore），仓库转公开，Releases 放本仓库，workflow 用自带 `GITHUB_TOKEN`；alpha 在本机用 Apple Development 身份签名后 `release:local` 发布（README 写明首次打开的信任步骤）。

### 第 13 刀：SDT-lite — PDF 的 Text 视图 — 已完成 2026-09-22（设计见 `docs/design/reading-mode.md`）
- 引擎 `engine/pdf-reflow/`（无模型，纯规则）：pdf.js 文本项 → 字形块（含旋转、粗斜体）→ 基线组行 → 页眉页脚 / 页码 / arXiv 水印去除 → 横向投影找栏沟分栏（≤ 3 栏，通栏带独立）→ 阅读顺序 → 段落（行距、缩进、字号变化、列表标记）与连字符回接、跨栏跨页续接 → 标题分类与层级（编号 / 字号 / 粗体）→ 图表区域（caption + 空白 / 无 caption 网格）用 pdf.js 在 Node 里 2× 裁剪成 PNG，经 `quire-figure://` 交给阅读器 → 装配 reader.document.v2 + Markdown + `plain` + 逐行锚点（page + 归一化 rect + plain 偏移）+ 报告。与材料标题重复的首标题不再重复渲染。
- 视图：任何有 pdf 视图的材料自动带一个 `available` 的 text 视图，按需本地构建（25 页双栏 arXiv 论文 1.2 秒）；可设为主视图。
- 渲染：Text 分段、"reflowed from PDF" 标签、降级页横幅、Info 里的报告；批注在 Text ↔ PDF 之间按锚点双向映射（text-quote ↔ pdf-regions），Notes 标注视图、跳转不切视图。
- 实测三篇：arXiv 双栏（2 栏、37 标题、20 图表、无降级页）、ICLR 单栏、Attention Is All You Need（编号大纲到三级、图表齐全）。
- 已知残留：附录密集网格的无 caption 表误判、NeurIPS 首页作者网格按行读、首页脚注成段、行首 "(1)" 当列表；下一步按 20 篇不同排版 PDF 做评测集，再决定是否上小块分类模型。

### 第 14 刀：Jev 块判定（可选） — 已完成 2026-09-22
- `engine/pdf-reflow/judge/`：规则先给每个块定性并标记 `certain`（多行正文、编号标题、带 caption 的图表、参考文献段确定；短行 / 粗体短块 / 首页前文 / 页边 12% / 图表邻块 / "(1)" 开头 / 无 caption 网格不确定）。不确定块（fixture 24.5%，双栏论文 25–35%，RFC / 幻灯片 / 书 60–100%）按页打包问 TypeSafe Jev（`choice` 九类 + `noul` 续接），置信 ≥ 0.75 且与规则不同才采纳、续接 ≥ 0.8 合并；家具丢弃、表格裁图、caption 附到最近无 caption 的图、脚注移到页末、参考文献自成一节。20 s 超时、3 页并发、5xx/429 重试一次；失败不破坏构建，`report.judged.error` 说明原因。
- 设置：`reflowJudge` rules|jev，TypeSafe key 用 `safeStorage` 加密存 `settings.json`（`engine/secrets.ts`，无法加密即拒绝），只回报 `typesafeApiKeySet`，无 key 拒绝选 Jev，删 key 自动回到 rules；Settings › Agent 有密码框与分段控件，Info › Views 显示 "refined by Jev · n asked · m changed"。
- 评测 `eval/pdf/`（`node run.mjs`，语料本地不入库）：20 篇 PDF 规则 vs Jev 并排，报告 `eval/pdf/report.md`（含手写 verdicts.md）。整轮约 1.3 M input tokens（≈ $0.05）。Jev 明显帮到的：RFC 页脚 / 版权、幻灯片图片授权行、遗漏的无编号标题与小写编号小节、表格行成文的裁图、OCR 全大写标题；曾伤到、已加护栏的：粗体行内小标题被升为标题（run-in 提示 + ≥ 25 词多行正文拒绝 heading）、逐行裁表（同页同栏、行距 ≤ 1.5 行高的 table 判定合并成一张图并挂最近的 "Table N" caption）、长段落被当家具（> 12 词且不在页边 12% 内保留）；仍会伤到的：句号结尾的标题被当 run-in、OCR 乱码行升标题、RFC 目录短行被当家具。

### 第 15 刀：文章质量的两条回路 — 已完成 2026-09-23
- 设计：`docs/design/eval-feedback.md`。一个数据格式：用户在 app 里报的"这页渲染坏了"就是评测集的一条 case（`report.json` + 语料条目布局的 `meta.json` + `page.html.gz` + `extracted.md`）。
- app 内反馈：阅读器工具栏的质量 pill 变成菜单（Report rendering problem… / Rebuild with the agent），Info › Quality 行与低质量横幅也有 Report…；`FeedbackSheet` 九种问题（`RenderingProblemKind`，与 judge 同一词表）+ 备注 + "附上保存的原始页面"，明列将保存的内容；只写本地 `<userData>/feedback/<id>/`，第二步才由用户打开预填的 GitHub issue（模板 `.github/ISSUE_TEMPLATE/rendering.yml`）并手动附 bundle；Settings › Feedback 列出所有报告。主进程 `engine/feedback.ts` / `feedback-issue.ts` / `ipc-feedback.ts`。
- 自动测评 `eval/judge/`：`pnpm --filter @read/eval judge [slug…] [--force] [--model] [--max] [--update-baseline]` 用 `codex exec --output-schema` 按七维量规给每篇 PASS / MINOR / MAJOR + issues[kind]，按内容哈希缓存 `out/`，与提交的 `baseline.json` 比较，任何 slug 变差即失败；报告 `eval/judge/report.md` 含按 kind 的问题计数。`pnpm --filter @read/eval import-feedback <bundle>` 把用户 bundle 变成语料条目。首次跑通：arXiv HTML 的报告 → 语料 → golden → judge 判 MAJOR（byline 缺失、GFM 里公式 TeX 注释与符号重复、附录表格成转义 HTML）——这三条是下一刀抽取器要修的。
- 第二版（同日）：judge 变成 Claude Code + Codex 混合，`eval/judge/config.json` 定策略（默认 Haiku 筛查、Codex 确认），每个结果带两边的 opinions；`judge:publish --html` 出自包含交互报告，`--issue` 把带 Mermaid 图表的报告发成一条可反复更新的 GitHub issue，`--cases` 给最严重的 case 各开一条 issue。
- 顺手修：preload 的 `version` 原来写死 0.0.1，现在由主进程经 `additionalArguments` 传入。

## 评测集导入 app
- Developer 菜单 → Import Evaluation Corpus（⌘⇧I，仅开发检出可见）把 `eval/corpus` 全部快照按当前抽取器入库；2026-09-18 实测 64 篇导入、0 失败。浏览器预览也直接列出导出后的语料（`EXPORT=1`）。
- 第二轮独立评审（`eval/quality-review-2.md`）：46 通过 / 4 轻微 / 14 严重（首轮 36 / 6 / 22）；随后又修了 Paul Graham 脚注、卡片链接的 Markdown、尾部 discuss / read-my-book 段。剩余主要是站点级残留（Quanta、Stratechery 的相关文章卡片），留给 L3 profile。

## 工作方式
- 先写引擎测试再接 UI；渲染层验证走浏览器预览（`localhost:5173`，`api.ts` 的 preview 模式），主进程改动才重启桌面 app。
- 每个新交互先进 `@read/ui`，带 story 与键盘测试；a11y 对比度是阻断门。
- 范围门禁：tags、关系图、项目管理不进这几刀。

## 已完成
- 2026-09-16 `6001296` 仓库脚手架、ADR 0001、`@read/ui`。
- 2026-09-17 `c6d87a3` M0 第一刀：normalize + reader 迁移，URL 抓取即读。
- 2026-09-17 `e520754` M0 第二刀：Aa 阅读设置、⌘F 页内搜索、文件拖入、浏览器预览模式。
- 2026-09-17 `30e4830` 第 1 刀：PDF 阅读器；`db34c19` 目录刻度轨与双指缩放。
- 2026-09-18 第 2 刀：评测集 64 篇 100%、抽取器与元数据修复、低质量横幅。
