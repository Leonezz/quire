# 文章质量：自动测评与用户反馈（2026-09-23）

两条回路，一个数据格式：**用户在 app 里报的"这页渲染坏了"，就是评测集里的一条 case。**

```
用户 ──Report rendering problem──▶ <userData>/feedback/<id>/   ──import-feedback──▶ eval/corpus/<slug>/
                                     report.json                                     page.html.gz
                                     meta.json  (corpus entry 布局)                   meta.json
                                     page.html.gz                                     expected.json (GOLDEN=1)
                                     extracted.md
                                            │
                                            └──Open issue──▶ GitHub issue（模板 rendering.yml，预填 URL / 版本 / 质量报告；bundle 手动拖上去）

开发 ──pnpm --filter @read/eval judge──▶ eval/judge/out/<slug>.json（缓存）──▶ eval/judge/report.md
                                         Codex 读 source.txt + extracted.md，按固定量规给出 PASS/MINOR/MAJOR + issues[]
                                         与 eval/judge/baseline.json 比较：任何 slug 变差即失败
```

## A. Agent 驱动的自动测评（`eval/judge/`）

现状：`eval/` 的 65 个快照只做**结构**比对（golden summary diff + P0 规则），"读起来对不对"靠人工让 Sonnet 子代理写 `quality-review*.md`，不可重复、不进 CI。

做法：把那次人工评审固化成一个可重复的 judge。

- **输入**：每个 case 的 `source.txt`（原始页面的结构化文本，`captureTextOf`）和 `extracted.md`（抽取结果），与 `eval/out/<slug>/` 一致；judge 自己生成，不依赖先跑 `EXPORT=1`。
- **模型**：`codex exec`（开发机已装、走用户的 ChatGPT 账号），`--output-schema` 强制结构化输出，`-s read-only`，每 case 一次调用。不用 Jev：文档级比对超出它的"快判"定位。
- **量规**（与 `quality-review.md` 的 0–2 七项一致，折成一个结论）：
  `{ verdict: PASS|MINOR|MAJOR, issues: [{ kind: RenderingProblemKind, severity: minor|major, evidence: "≤200 字原文引用", note }], summary }`。
  `kind` 与 app 里用户反馈的 `RenderingProblemKind` 同一套词表（`apps/desktop/src/shared/contracts.ts`），所以两边的统计能合在一张表里。
- **缓存**：`eval/judge/out/<slug>.json`，键 = sha256(source + extracted + 量规版本 + 模型)。抽取器没变的 case 不再花钱。
- **基线与门**：`eval/judge/baseline.json`（提交进仓库，只含 verdict 与 issue kinds，不含第三方内容）。运行时任何 slug 比基线**变差**（PASS→MINOR/MAJOR，MINOR→MAJOR）即失败；变好则提示 `--update-baseline`。
- **报告**：`eval/judge/report.md`：总计 PASS/MINOR/MAJOR、按 kind 的 issue 计数（这就是"下一刀修什么"的清单）、每 case 一行。
- **命令**：`pnpm --filter @read/eval judge [slug…] [--force] [--model M] [--max N] [--update-baseline]`。没有 codex、没登录、schema 不合法都是显式报错。

## B. 用户层面的渲染质量反馈（app 内）

参考：Readwise Reader 的 "Report parsing issue"（一键把 URL + HTML 发给团队）、Pocket 的 "Report article problem"（选原因）、Firefox Reader View 的 bug 表单。共同点：**入口就在阅读页上、选原因、附原页**。差异：它们默默上传；Quire 本地优先、公开仓库，所以**本地保存 + 明示内容 + 用户自己发 issue**。

- **入口**：阅读器工具栏的质量 pill（"web extract · partial" 那个）和 Info 面板的 Quality 行，都多一个 "Report rendering problem…"；quality 为 low 时 QualityBanner 也给这个动作。
- **表单**（`FeedbackSheet`）：原因多选（9 个 `RenderingProblemKind`，按阅读者的话写）、备注、"附上保存的原始页面"（有 capture 时默认勾选，明说它会进 bundle）、一段"将保存的内容"清单（URL、标题、视图、app / 抽取器版本、质量报告、问题列表）。按 Save 只写本地。
- **保存后**：sheet 变成两步——"Open GitHub issue"（浏览器打开预填的 issue；capture 永不进 URL）和 "Reveal bundle"（Finder 里定位，拖到 issue 上）；可把 issue 链接粘回来记在 record 上。
- **Settings › Feedback**：列出所有报告（标题、时间、原因、是否已开 issue），每条可 Open issue / Reveal / Delete；空态一句话说明报告只存本地。
- **闭环**：`pnpm --filter @read/eval import-feedback <bundleDir>`（或 zip）把 bundle 复制成 `eval/corpus/<slug>/`，在 `corpus.json` 追加条目（tags = kinds），然后 `GOLDEN=1` 生成 golden，`judge` 给出结论。

## C. 混合 judge、结构化报告、发布到 issue（2026-09-23 第二版）

**两个后端，一个策略文件。** `eval/judge/config.json`：

```json
{ "policy": "screen-then-confirm",
  "screen":  { "backend": "claude", "model": "claude-sonnet-5" },
  "confirm": { "backend": "codex",  "model": "gpt-6-luna" },
  "escalateOn": ["MINOR", "MAJOR"], "concurrency": 3 }
```

- `claude` 后端 = Claude Code 无头模式（`claude -p --output-format json --json-schema … --tools "" --permission-mode plan --max-turns 1`），走 Claude 订阅；`codex` 后端 = `codex exec --output-schema`，走 ChatGPT 订阅。两边都只读文本、禁工具、结构化输出、注入式 runner 可测。
- 三种策略：`single`（一个后端）、`screen-then-confirm`（便宜的筛查者判全部，不是 PASS 的再由确认者复判，最终以确认者为准，意见不同记 `disputed`）、`both`（都判，取更严重者，issues 取并集）。默认 screen-then-confirm，Claude Sonnet 5 筛查（$2/$10 每百万 token；2026-09-25 从 Haiku 换过来，Haiku 与 Codex 在 31 次升级里有 12 次意见相左）、Codex GPT-6-Luna 确认——约一半的 case 在 PASS 处停下，只付筛查的钱。筛查者若在 PASS 里列出 major issue 也会升级（`escalateOnMajorIssue`）。
- 每个结果记录所有 `opinions[]`（后端、模型、verdict、issues、token、美元、耗时）和 `resolution`；缓存键含策略与模型，换策略即重判。
- 命令行：`judge [slug…] --policy … --backend … --model … --screen-model … --confirm-model … --force --max --update-baseline --concurrency`。只预检策略用到的后端；Claude 未登录时立刻报 `claude login`。

**报告三种形态**（`pnpm --filter @read/eval judge:publish`）：
- `report.md`（入库）：总计、按 kind 计数、每 case 一行（由谁裁定、是否有分歧）。
- `report.html`（`--html`，本地、不入库）：自包含交互页——verdict 环图、按 kind 的堆叠条形图、筛查 vs 确认的混淆矩阵、相对基线的退步/进步、可筛选排序的 case 表，展开看每条 issue 的证据引用与两个后端并排的意见。
- GitHub issue（`--issue`）：一条带 `quality-report` 标签的跟踪 issue，正文含 Mermaid 饼图与条形图（GitHub 原生渲染）、基线对比、每个 MAJOR case 一个 `<details>`；同一 issue 反复更新并追加"Updated …"评论。`--cases --max-cases N` 另为最严重的 N 个 case 各开一条 `rendering` + `judge` 标签的 issue，按标题去重。`--dry-run` 只打印。

## 不做的

- 不做自动上传 / 遥测端点。等有了自己的收集服务再加 `Settings.feedbackEndpoint`，bundle 的 JSON 信封已经定好。
- 不在 CI 里跑 judge（要 Codex 登录、要花钱）；`judge` 是开发机命令，报告提交进仓库。
