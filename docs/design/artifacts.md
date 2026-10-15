# Artifact 能力（2026-10-14）

## 问题

agent 只能产出 Markdown。综述、笔记这类文本够用，但图表、时间线、可排序的对比表、示意图、小工具都表达不出来；修改也只能整篇重写，没有版本。目标是在能力上对齐 Claude 的 artifacts：多种类型、可交互的 HTML 在沙箱里运行、增量编辑并保留版本，引用照常可点。

## Claude artifacts 的做法（参考）

| 方面 | Claude | Quire（本阶段） |
|---|---|---|
| 类型 | Markdown、代码、HTML、SVG、Mermaid、React | Markdown、代码、HTML、SVG、Mermaid、React |
| React 可用库 | react、recharts、d3、lucide-react、lodash 等，Tailwind 类名 | react、recharts、d3、lucide-react、lodash，Tailwind 类名（本地打包，按 import 按需加载） |
| 运行出错 | 显示错误，"Try fixing" 交给 Claude | 显示错误，"Ask the agent to fix it" 交给 agent 用 `artifact_update` 修 |
| 版本 | 版本切换、恢复 | 阅读器里逐版查看，"Restore this version" 以新版本恢复 |
| 隔离 | 独立域名的 iframe，严格 CSP，只能用白名单 CDN | 自定义协议 `quire-artifact://`，`sandbox="allow-scripts"`（opaque origin），CSP 禁止一切外部加载与网络 |
| 与宿主通信 | postMessage | postMessage 桥：高度、主题、外链、打开素材 |
| 编辑 | `update`（替换唯一片段）/ `rewrite` | `artifact_update`（`old_str` 必须唯一）/ `artifact_rewrite`，每次 +1 版本，旧版本存为 `<id>.rev<n>.json` |
| 引用 | 无（Citations API 是独立能力） | Markdown 中 `[id]` 渲染为编号引用 + Sources 列表；HTML 中 `<a href="quire:material/ID" data-quote="…">` |

## 数据模型

- `MaterialRecord.artifact = { type, language?, version, updatedAt }`；旧的 agent artifact 视为 `markdown` v1。
- `artifactSource` 保存原文，是编辑的对象；`material_read` 返回它，agent 改之前能读到精确原文。
- Markdown / 代码走阅读器管线（代码包成足够长的 fence）。HTML / SVG 的 mediaType 为 `application/vnd.quire.artifact+html|svg`，主视图是新的 `artifact` 视图；`plain` 由标记抽取文字，供搜索与阅读时长。

## 沙箱

```
渲染进程（CSP: frame-src quire-artifact:）
 └─ <iframe sandbox="allow-scripts" src="quire-artifact://artifact/<id>?v=N&scheme=dark">
      主进程 protocol.handle：仅对 origin=agent 且 type=html 的素材返回页面
      响应头 + meta CSP：default-src 'none'; script/style 'unsafe-inline'; img/media/font 只允许 data:/blob:; connect-src 'none'
      注入：基础主题变量 + 桥脚本（在 artifact 自己的脚本之前运行）
 主进程 will-frame-navigate：子框架只能导航到 quire-artifact:
```

已在 Electron 里实测（xvfb）：脚本可运行；localStorage、`parent.document`、IPC 均不可用，origin 为 `null`；fetch 与远程图片被 CSP 拦截；子框架导航到 https 被拦截；桥消息 ready / size / open-link / open-material（带 quote）/ theme 都能到达，主题色实时生效。

渲染端（`ArtifactFrame.tsx`）只接受来自该 iframe 的消息，素材 id 必须是 16 位 hex，外链只允许 http(s) / mailto，高度限定在 160–40000px。阅读器主题变化（显式切换或系统切换）会重新发送 `--quire-*` 变量，不需要重载。SVG 以 `data:` 图片绘制，不执行脚本。

## React 与 Mermaid 运行时

- `scripts/build-artifact-runtime.mjs` 在 `dev` / `build` 前用 esbuild 把 react、recharts、d3、lucide-react、lodash、mermaid 打成独立的 IIFE，复制 `@tailwindcss/browser`，输出到 `out/artifact-runtime/`。每个文件把模块注册到 `window.QuireModules`；React 只打包一次，其他库通过插件引用同一份。
- 协议在 `quire-artifact://runtime/<file>.js` 提供这些文件；artifact 页面的 CSP 只多放行了这个来源（以及 `'unsafe-eval'`：沙箱里本来就能跑任意脚本，eval 不增加能力，但 d3 的 CSV 解析需要它）。
- React artifact 在主进程用 sucrase 编译（JSX + TS → CommonJS），根据 `require(...)` 只加载用到的库；不认识的模块、编译错误、缺少 `export default` 在保存时就报给 agent。页面里提供 `require` 垫片和错误边界。
- Mermaid artifact 用 `securityLevel: "strict"` 渲染，跟随阅读器明暗主题重绘。
- HTML artifact 也可以 `<script src="quire-artifact://runtime/d3.js">` 使用这些库。
- 运行时错误（`error`、`unhandledrejection`、错误边界、Mermaid 解析失败）经桥回报给阅读器，显示错误并提供"让 agent 修复"，在该素材的对话里发起一轮。

## 版本

- 协议支持 `?v=N` 取历史版本；`artifact:version` 返回某个版本的视图内容，`artifact:restore` 用旧版本的源码和标题生成新版本（不覆盖历史）。
- 阅读器标题下方显示 "Version 2 of 3" 与前后切换；查看旧版本时可 "Restore this version" 或 "Back to latest"。

## agent 工具

- `artifact_write { title, type, language?, content, sources }`
- `artifact_update { id, old_str, new_str, sources? }`：片段必须恰好出现一次，否则报错让 agent 扩大上下文
- `artifact_rewrite { id, content, title?, sources? }`
- 提示词说明何时选哪种类型（交互用 react，图示用 mermaid），以及沙箱约束（无网络、可用模块、用 `--quire-*` 变量、链接式引用）。

## 内容质量与渲染

Artifact 的价值是沉淀值得阅读、收藏的内容，所以质量要在三处同时把关。

**内容**
- 提示词里有一段编辑标准：标题要说清主题和结论，开头一段导语直接给答案，小标题陈述该节要点而不是"背景""总结"，每个论断带原文引语和引用，适合时用表格、callout（`> [!TIP] Key takeaways`）、图表，不写套话和 emoji，用读者的语言。
- 保存时 `reviewArtifact`（`engine/artifact-review.ts`）像编辑一样过一遍：泛泛的标题、缺导语、长文无小标题、空洞的小标题、手写参考文献、无引用或引用无原文、裸 id、套话（中英）、超长段落、emoji、写死的颜色、Mermaid 节点过多。结果作为 `review` 随工具结果返回，并要求 agent 用 `artifact_update` 改一轮再回复。

**展示形式**
- Markdown 支持 GFM alert（`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION] 标题`），渲染为带色调的 callout；紧凑列表不再有段落间距。
- React artifact 可以 `import { Page, Lead, Section, Stats, Stat, Figure, Legend, Cite, Callout, DataTable, Tabs, Timeline, chart } from "quire"`（`src/artifact-kit/`，打包成 `quire-artifact://runtime/quire.js`）。组件自带排版和主题；`<Cite id quote>` 与 `Figure` 的 `source` 都算引用，出现在下方的 Sources 列表里。
- 图表用 `chart.color(i)` 等预设：8 色分类色板经色觉缺陷校验（浅色、深色各一套），轴线、网格、tooltip 都跟随主题。

**渲染样式**
- 所有 artifact 页面共享 `artifact-style.ts` 生成的样式，放在 `@layer quire`（位于 Tailwind preflight 之后、utilities 之前），所以 Tailwind 类仍可覆盖。主题变量 `--quire-*` 由阅读器实时下发，包括正文宽度 `--quire-measure`，让 `Page` 与阅读器标题对齐。
- Tailwind 主题暴露 `bg-surface`、`text-muted`、`border-line`、`text-accent`、`bg-chart-1..8` 等语义类，不鼓励写死颜色。
- Mermaid 使用 `base` 主题，节点、连线、文字颜色从 `--quire-*` 计算，切换明暗时重绘。
- 阅读器侧：Markdown artifact 的导语段放大、标题下显示日期，正文做弯引号与省略号的排印替换。
- 框架高度按内容实际高度（`getBoundingClientRect`）上报，可增可减；页面本身不出现滚动条。

## 后续阶段

1. ~~运行时库~~（已完成）。可以继续补 shadcn/ui 组件、mathjs、papaparse 等 Claude 也提供的库。
2. ~~版本 UI~~（已完成）。可以加版本间 diff。
3. **结构化引用**：保存时校验 `{materialId, quote}`，quote 必须能在素材原文中找到，对齐 Claude Citations API 的 `cited_text`。
4. **宿主能力桥**：`window.quire` 提供受控的只读能力（读取已引用素材、向 agent 提问），每项都显式授权。
5. **持久状态**：按 artifact 存小量 JSON 状态（替代被禁用的 localStorage）。
6. **导出**：HTML 单文件 / PNG / PDF。
