# Agent 运行时（2026-09-19）

## 现状为什么"切走就停"

一次提问的全部实时状态——流式答案、工具行、等待中的 `agentAsk` promise——都住在 `AgentPanel` 里的 `useAgent` hook。切换视图时面板卸载，状态随之丢弃；主进程里的 turn 其实还在跑，但重新挂载的面板只能从数据库读到"用户轮"，看不到进行中的答案，只能显示"Still answering elsewhere…"，直到 turn 结束才有结果。这不是"停止"，是 UI 把运行状态绑在了视图上。

## 标准做法

| 实现 | 结构 |
|---|---|
| VS Code Copilot Chat | `ChatService`（工作台单例）持有每个会话的 `ChatModel`；请求在模型上推进，进度写进 `ChatResponseModel`；`ChatWidget` 只是模型的视图，关闭 / 隐藏 / 换会话都不影响请求；重新打开时从模型重绘 |
| Zed agent panel | `ThreadStore` 全局持有 `Thread` 实体，流式增量直接写到实体；面板是实体的视图；线程在后台继续，完成时发通知 |
| Cursor / Claude Code 桌面 | 后台会话列表，每个会话有运行状态；离开再回来看到的是同一段进度；完成时系统通知 |
| Codex app-server | thread 在服务端持久；客户端只维护 cursor，掉线后用 `thread/read` 补状态；多个 thread 可以同时有 turn |

共同点：**运行状态在视图之外**（一个运行时 / store），**事件是持久日志**（可重放、可补齐），**视图只订阅**，**多个运行可并行**，**完成时有通知**。

## Quire 的设计

```
主进程                                         渲染进程
AgentService                                   agentStore（单例，useSyncExternalStore）
 ├─ runs: Map<sessionId, Run>                   ├─ runs: Map<sessionId, RunState>
 │    Run = { turnId, threadId, task, prompt,   │    从 listAgentRuns() 取快照，再按 agent:event 增量更新
 │            answer(累积), tools[], startedAt } ├─ 任何面板按 sessionId 读取；挂载 / 卸载不影响 run
 ├─ ask() 立即返回 { sessionId, turnId }         ├─ 完成时把 run 折成会话里的一轮（agent:sessions:changed 触发重读）
 ├─ 事件都带 sessionId，广播给所有窗口             └─ 侧栏 Agent 条目显示运行中的数量
 ├─ 每个 thread 一次一个 turn；不同会话并行
 └─ 完成 / 失败：写会话轮次；窗口未聚焦则发系统通知
```

### 规则

1. **`agentAsk` 不再等结果**。它校验、建会话、启动 turn，立刻返回 `{ sessionId, turnId }`；结果只通过事件与会话记录交付。UI 不会再拿着一个会被卸载的 promise。
2. **每个事件带 `sessionId`**。渲染层按会话路由，与哪个面板在看无关。
3. **快照 + 增量**。`listAgentRuns()` 返回进行中的 run（含累积答案与工具行）；store 启动时取一次，之后靠事件。面板挂载时从 store 读，不发请求。
4. **并行**。`TURN_RUNNING` 只针对同一会话（同一 thread）；不同材料 / Library 的问题可以同时跑。CodexClient 按 threadId 维护多个 binding，通知与工具调用按 threadId 路由。
5. **中断按会话**：`agentInterrupt(sessionId)`。
6. **通知**：turn 完成或失败时，若窗口未聚焦，发 macOS 通知（标题 = 会话标题，正文 = 答案首行）；点击通知打开该会话。窗口聚焦但不在看该会话时，侧栏 Agent 条目计数变化即可。
7. **重启后的孤儿**：应用退出时正在跑的 turn 记为 `interrupted`（会话里留一条"应用退出时中断"）。
