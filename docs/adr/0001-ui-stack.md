# ADR 0001 · UI 技术栈与组件基座

Status: accepted · 2026-09-16

## 决定

| 层 | 选择 | 版本 |
|---|---|---|
| 交互基座 | **React Aria Components**（Adobe） | 1.21 |
| 样式 | Tailwind v4 + 设计令牌（CSS 变量，来自 `design/reading-first/apple.css`） | 4.3 |
| 壳 | Electron + electron-vite（main / preload / renderer 三进程模板） | 44 / 5.0 |
| 构建 | Vite 7（electron-vite 5 的上限）、TypeScript 5.9、pnpm workspace | |
| 面板与布局 | react-resizable-panels（列表 / 预览 / inspector 拖拽分栏） | 4.x |
| 浮层定位 | React Aria 的 Popover / Menu / Dialog；选区弹层用 @floating-ui/react（虚拟锚点） | |
| 长列表 | React Aria `Virtualizer` + `ListLayout`（GridList / ListBox 原生虚拟化） | |
| 拖拽排序 | React Aria `useDragAndDrop`（GridList 内置，含键盘拖拽与可访问公告） | |
| 命令面板 | React Aria `Autocomplete` + `Menu`（⌘K），不引入 cmdk | |
| Toast | React Aria `ToastQueue` | |
| 阅读器高亮 | CSS Custom Highlight API（Chromium 原生，不改 DOM）+ text-quote 锚点 | |
| PDF | pdfjs-dist（自绘文本层，区域标注） | 6.x |
| 数学 / 代码 | KaTeX / Shiki（worker 内渲染） | |
| 动效 | motion，只用于列表 → 阅读的布局过渡与面板开合 | |
| 状态 | zustand（UI 状态）+ TanStack Query（IPC 读缓存，按 watermark 失效） | |
| 组件契约与测试 | Storybook 10 + addon-vitest（Playwright 浏览器）+ addon-a11y；Vitest 5 | |

## 为什么是 React Aria Components 而不是 Radix / shadcn

产品的交互面几乎全是"列表与键盘"：Inbox 三键决定、Queue 拖拽排序、多选、⌘K、inspector 标签、弹层与菜单。这些是最容易出边界 case 的地方（焦点丢失、Shift/⌘ 多选语义、typeahead、拖拽的键盘替代、滚动容器内的虚拟化）。

- React Aria 把 **选择模型**（single / multiple，与 macOS 一致的 Shift 范围与 ⌘ 切换）、**焦点管理**、**typeahead**、**虚拟化**和**拖拽**做成同一套受状态机驱动的组件，且以 render props / data 属性暴露状态，样式完全由我们决定。Radix 没有列表/选择/拖拽/虚拟化，这些在 Radix 生态里要拼四个库。
- 交互语义按平台区分：`usePress` 区分鼠标、触控板、键盘的按压；hover 不在触屏上触发；焦点环只在键盘时出现。这些正是"不想再修的交互问题"。
- 国际化与 RTL、日期与数字格式化内建；中文界面不需要额外处理。
- 代价：包体比 Radix 大；GridList 等组件的 DOM 结构较固定；`Virtualizer` 的 API 仍在演进。可接受。

## 不选的

- MUI / Mantine / Ant：自带视觉，去皮成本高，和 macOS 语言相悖。
- shadcn/ui：是"复制进仓库的 Radix + Tailwind 预设"，视觉要全改，且缺列表与拖拽。
- 自研 primitives：这正是要避免的时间去向。

## 约束

- 所有可交互元素必须来自 `@read/ui`；业务代码不直接引用 `react-aria-components`。这样交互修复只发生在一个地方。
- 每个 primitive 有 Storybook 故事与至少一个键盘交互测试；a11y 检查阻断（对比度 4.5:1）。
- 令牌只在 `packages/ui/src/tokens.css` 定义，Tailwind 通过 `@theme inline` 引用；组件里不出现裸色值。
