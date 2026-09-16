# Reading Workbench

一个材料进来，得到同一种好的阅读体验；读完留下的东西，同样好读。

- `packages/ui` — 设计系统与交互基座：React Aria Components + Tailwind v4，令牌来自 `design/reading-first`。Storybook 承载组件契约与浏览器测试。
- `packages/core` — 领域模型（materials, items, sources, annotations, reading events）。无 UI 依赖。
- `apps/desktop` — Electron（electron-vite）壳：原生 vibrancy 窗口、隐藏标题栏、单一 JSON-RPC 边界。

```bash
pnpm install
pnpm dev          # desktop app
pnpm storybook    # component library
pnpm typecheck && pnpm test
```

决策记录见 `docs/adr/`。产品设计见 `../research/reading-first-mvp-*.md`（迁入前的位置）。
