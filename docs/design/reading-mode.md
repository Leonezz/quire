# Zotero 10 Reading Mode：实现方式与 Quire 的选择（2026-09-21）

## 它是什么

Zotero 10（2026-08-17）给 PDF 加了 Reading Mode：把正文重排为单栏、连续滚动、可调字体 / 字号 / 行距的视图，去掉页眉页脚和多栏；无法转成文字的区域（图、表）按原样从 PDF 渲染；在 Reading Mode 里划线、下划线、批注会同步显示到普通 PDF 视图，阅读位置也互通；文字 / 图片 / 墨迹类批注只在 PDF 视图显示。官方说它"由 Read Aloud 背后同一套自研文档分析系统驱动"。

## 实现方式（读源码得到的）

三层，分在三个仓库：

1. **分析：`zotero/pdf-worker`（AGPL-3.0）`src/pdf/structure/`**。输入 pdf.js（Zotero 自己的 fork）的文本项与页面几何，输出"结构化文档"。关键部件：
   - `model/block-seg/`：两个 ONNX 模型（classifier 4.4 MB，clusterer 4.4 MB + repair 0.36 MB）做**块分割与分类**——先把文本行聚成块，再给块分类；`features.js` / `input.js` 是手工特征工程，`inference.js` 87 KB；运行时用 onnxruntime-web。
   - `flow-policy.js`：每个块一个 flow class——`body` / `auxiliary` / `excluded`；只有 body 进入阅读流，跨页续接只在相邻且非"降级抽取"页之间发生。
   - `page-furniture.js`：跨页重复的页眉页脚 / 页码按文本模式与 bbox 位置识别并排除；`page-label.js` 处理页码标签。
   - `outline/outline.js`（59 KB）标题层级；`figure.js`、`table/`、`math.js` 标记图表公式区域（图表以原页区域渲染）；`citations.js` / `citation-refs.js`（47 KB）/ `footnote-refs.js` / `reference/` 识别引文、脚注与参考文献并建链接；`list-relations.js` 列表。
   - `apply-refs.js`：把结构树里的每段文字**映射回 PDF 页坐标**——这是批注能双向同步的基础。
2. **格式：`zotero/structured-document-text`（SDT）**。`{ schemaVersion, metadata, catalog{pages, outline}, content[] }`，持久化为二进制 `.sdt` pack（header / index / 压缩的 metadata、catalog / 分块压缩的 content，可随机访问）。同一格式也用于 EPUB 与网页快照（`src/dom/snapshot/dommap.js` 保存 DOM 映射）。README 明说用途包括 reading mode、PDF 文本层、大纲预览、**给 agent 的结构化上下文、按节切块做 embedding**。仓库里**没有 LICENSE 文件**，package.json 也没有 license 字段。
3. **渲染：`zotero/reader`（AGPL-3.0）**。`src/dom/sdt/sdt-view.ts` + `lib/renderer.ts` 把 SDT 渲染成 DOM，复用 EPUB / 快照那套 DOM 阅读器（所以有字体、行距、分页 / 滚动 flow）；`src/common/sdt/pdf-position-mapper.ts` 等 position mapper 在"SDT 文本偏移 ↔ PDF 页坐标 ↔ DOM Range"之间换算，批注因此在两种视图里都能画；`src/pdf/sdt-integration.mjs` 还把 SDT 用作 PDF 视图的搜索与选区流（`selection-flow.mjs`）。

## Quire 能不能用

**直接用代码：不能，除非 Quire 自己采用 AGPL-3.0。** pdf-worker 与 reader 都是 AGPL；SDT 仓库无许可证，默认保留所有权利。Quire 目前还没有 LICENSE，这是要先做的决定。此外它依赖 Zotero fork 的 pdf.js 与约 9 MB 的模型，与我们的 pdfjs-dist 6.3 不是一个分支。

**用它的架构：可以，而且我们已经有一半。**

| Zotero 的部件 | Quire 现状 |
|---|---|
| SDT 作为"一个材料的多种读法"的中间层 | 已有 `views`（web / pdf / markdown）与 `MaterialViewContent`，加一个 `text` 视图即可 |
| 结构树渲染成 DOM、可调字体行距 | `reader.document.v2` + `ReaderDocumentSurface` + Aa 设置 |
| 文本 ↔ PDF 坐标映射，批注双向 | 已有 text-quote 锚定（文章）与 pdf-regions 锚定（PDF）、`Annotation.view`；缺的是两者之间的换算表 |
| 页眉页脚、多栏、段落、图表 | 无；`pdf.ts` 只取前三页文本做标题 |
| 结构化上下文给 agent | agent 工具 `material_read` 只有平文本 |

## 建议

分两步，先不引入模型：

**第一步：启发式 SDT-lite（一刀）。** 主进程 `engine/pdf-reflow.ts`，输入 pdf.js `getTextContent()` 的文本项（含 transform、宽高、`hasEOL`）与页面尺寸：
- 行合并 → 按 x 区间聚类分栏（≤ 3 栏）→ 栏内按 y 排序 → 段落切分（行距 / 首行缩进 / 行尾标点）→ 连字符断词回接；
- 页眉页脚：跨页在相近 bbox 重复的短文本（数字模式归一后比较，思路同 `page-furniture.js`）排除；
- 标题：字号 / 粗体相对正文突出的单行块 → heading，供目录刻度轨；
- 图表：文本稀疏的大矩形空洞或有 caption 前缀（Figure / Table / 图 / 表）的区域 → `image` 节点，渲染时按需从该页裁剪位图（`PdfCanvasViewer` 已能渲染页面）；
- 每段记录来源 `[page, bbox…]`，写成 `reader.document.v2` 的 `text` 视图，并保存"段落 → 页区域"映射表；批注：在 text 视图划线得 text-quote，同时换算出 pdf-regions 写入同一条记录，两边都能画。
- arXiv 仍以 HTML 渲染为首选（它本来就是最好的 reading mode）；`text` 视图主要服务其他 PDF。
- 验收：用评测集补 20 篇不同排版的 PDF（单栏 / 双栏 / 带页眉页脚 / 带图表），人工判定正文顺序与页眉页脚去除。

**第二步（视效果）：块分类模型。** 若启发式在双栏 + 浮动图表上不够稳，再训练或引入一个小的块分类器（Zotero 的做法证明 4 MB 级模型够用），或用 agent 的 rebuild 对个别文档兜底（把 `material_source` 的对象从 HTML 扩展到"按页带坐标的文本块"）。

**许可证决定**：若 Quire 打算以 AGPL-3.0 开源，第二步可以直接评估复用 pdf-worker 的 `structure/`（连同模型），并采用 SDT 格式与 Zotero 互通；否则只借架构，自己实现。

## 来源

- Zotero 10 发布博客：https://www.zotero.org/blog/zotero-10/
- Reading Mode beta 讨论：https://forums.zotero.org/discussion/comment/516634
- 代码：https://github.com/zotero/pdf-worker（`src/pdf/structure/`）、https://github.com/zotero/structured-document-text、https://github.com/zotero/reader（`src/dom/sdt/`、`src/common/sdt/`、`src/pdf/sdt-integration.mjs`）
