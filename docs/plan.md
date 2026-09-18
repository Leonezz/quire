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
