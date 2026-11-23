# v2.2.1 发布说明 — 撤卡改用官方 answer()，去除非官方 API 依赖

> 小修复版本（patch，用户明确指定递增至 2.2.1）。本轮把「微信回填后撤掉 DSH 原生选择卡」的实现从非官方 `PendingQuestion.dismiss()` 轮询彻底改为官方 `userQuestions.answer()`，去掉了对非官方 API 的依赖。插件仍不接管会话生命周期。完整架构背景见 [v2.2.0 发布说明](RELEASE_NOTES_v2.2.0.md)。

## 一句话

不再用非官方 `PendingQuestion.dismiss()` 去撤原生卡，改为在微信回填胜出时调用官方 `userQuestions.answer()`，让 DSH 投影按 callId 正常 settle 撤卡；同时移除整套 settled 队列、`/settled` 路由与 client 2 秒轮询。

## 修复清单

### 1. 撤卡改用官方 answer()（m01709）

- **重新定位根因**：卡残留不是「没有官方撤卡 API」，而是**时序错配**：
  - 窗口内回填（题状态 `state=open`）：插件返回值被 tool execute 消费 → `tool/result` 带答案 → 投影 `projection.ts:272-279` 自动 settle，卡本就消失。
  - 超时后晚到（题状态 `state=continued`）：插件此前只 resolve 内部 decision（AI 能继续），没走会产生 settle 事件的通道 → 投影停在 continued → 卡残留。
- **官方机制**：`userQuestions.answer(agent, callId, answer)` 正是为 pending 晚到设计（`dsh-user-questions/src/index.ts:191-205`）——steer 一条 `source.kind='user-question-reply'` 消息，命中投影 `user/message` 分支（`projection.ts:295-300`，不查 state、按 callId settle）。插件回填答案结构 `{answers:[{id,selected}]}` 与官方 execute 返回、`answerBatchSchema` 完全一致。
- **修复**：host 在 `resolveQuestions` 回填胜出时，按 callId/agent/答案调官方 `ctx.get('userQuestions').answer()`（try/catch，失败不影响回填；open 态官方返回 false，由 tool/result 自动 settle，两态互斥不重复结算）。

### 2. 清理全部非官方机制

- 删除 client 每 2 秒的 dismiss 轮询（`dismissedSettled`/`settledPollRequest`/`dismissSettledCards`/`settledTimer`）。
- 删除 host settled 队列（`settledQuestions`/`SETTLED_WINDOW_MS`/`getSettledQuestionIds`）。
- 删除 `/settled` 路由（`SETTLED_ROUTE`/`settledHandler`）。
- 不再依赖任何非官方 `PendingQuestion.dismiss()`，降低 DSH 升级带来的兼容风险。

## 验证

- `node smoke/smoke-test.mjs` → **97 项断言全部通过**。
  - 新增「微信回填胜出后调官方 `userQuestions.answer()`」回归，精确断言 callId、agent、答案（1B→乙）。
  - 此前 m00006 / m00497 / m00564 / m00713 / m01072 全部保持绿；路由数回归 9 条。
- `npm pack` 通过，tar 核验版本号与发布说明一致。

## 已知边界

- 官方 `answer()` 只能结算 `continued` 态的题（`open` 态返回 false，由 tool/result 自动 settle）；这是官方设计，两态互斥不会重复结算。
- 若宿主侧取不到 `userQuestions` service 或 `answer()` 失败，仅记录日志、不影响微信回填本身（AI 仍能继续），最坏情况原生卡仍需用户手动关。
- 版本号由用户拍板升至 2.2.1；本发布说明随版本包发布，实际 npm/GitHub/Gitee 发布动作需用户另行确认。
