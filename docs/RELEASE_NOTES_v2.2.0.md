# v2.2.0 发布说明 — 回填/计时根治 + 原生卡残留清理

> 纯修复版本（minor，用户明确指定递增至 2.2.0）。聚焦真机验证中暴露的回填误投、通知延迟、卡片残留等问题，其中通知计时改为宿主 Node 定时器属架构级调整。插件仍不接管会话生命周期。完整架构背景见 [v2.0.0 发布说明](RELEASE_NOTES_v2.0.0.md)。

## 一句话

修复微信回填误投、未绑定会话手动选择无反应、重复完成卡、通知延迟超 2 分钟、回填后 DSH 原生选择卡残留等 5 项真机问题，其中通知计时从浏览器渲染进程挪到宿主 Node 定时器，彻底规避后台节流。

## 修复清单

### 1. 微信回填码误投到已绑定会话（m00006）

- **根因**：DSH `ctx.waterfall` 是链式 `next()`，原生 UI 应答器 `dsh-client-ui-user-questions` 在 `answerQuestion` 中 pending 等用户点击且不调 `next()`；本插件 listener 默认排在链尾，回调永不执行 → 待决池为空 → 回填码在 `parseInbound` 判为 passthrough → 掉进自由对话误投给 activeSession。
- **修复**：
  - 两处 waterfall 应答者（`approval/request`、`user-questions/request`）注册加 `prepend: true`，抢占链首，本插件回调得以执行并注册待决。
  - 新增 `looksLikeQuestionReply()` 防御底座：形似 `<4-6 位前缀> <数字+字母>` 的文本绝不 `submitPrompt` 给 activeSession，而是用现成的 `resolveSessionByPrefix` 反查全会话并结算；无待决则明确回「前缀 X 当前没有待决选择题…未当作聊天转交」。

### 2. 未绑定会话 DSH 手动选择无反应（m00497）

- **根因**：prepend 后，未绑定会话的硬超时以空答案 `finish()` 抢先 settle `Promise.race`，变成「已跳过」，用户随后在 DSH 界面手选无人接收。
- **修复**：未绑定会话（有原生 UI 经 `next()` 兜底手选）超时只让微信回填失效、`questionPending.delete`，把最终答案交回用户手选；绑定会话（无兜底）仍 fail-closed 回空答案。

### 3. 正文已到仍发重复完成卡（m00564）

- **根因**：正文镜像（host 半边 `onAssistantStream` end 帧）与完成卡（client 半边 uiSession running 边沿）是两条独立通道，各发一条，无互斥。
- **修复**：host 发正文按 sid 打时间戳（`recentBodySent`），client 发卡带 `kind+sid`，`/wechat` 出站口统一拦截——done 卡若对应会话近期（默认 300s）发过正文就吞掉（`didRecentlySendBody`）；未绑定会话无正文镜像仍保留完成提醒。

### 4. 宿主计时根治微信通知延迟（m00713，架构级）

- **根因**：批次计时用浏览器渲染进程 `setTimeout`，DSH 窗口后台时 Chromium 把定时器节流到分钟级，30s 批次被拖到 2 分钟；窗口获焦点才补发。
- **约束**：host 与 client 之间只有 client→host 的 HTTP，宿主无法主动调 client 函数。
- **修复**：
  - 新增 `/notify-clock` 路由 + 宿主 Node 定时器：client 在事件边沿把「卡片内容 + 截止时间 + dedupeKey」预约给宿主，宿主准点发卡；已响应时事件驱动取消预约。
  - 抽出 `deliverCard()` 统一宿主计时器与 `/wechat` 出站，含 done-after-body 抑制 + 60s dedupeKey 跨通道去重，杜绝双发。
  - client 本地批次逻辑保留（兼容既有断言），桌面通知仍即时弹；仅微信卡改由宿主准点投递。

### 5. 微信回填生效但 DSH 原生选择卡残留（m01072）

- **根因**：本插件 prepend 胜出后，原生 UI 应答器的 callId 卡仍 pending 等点击；`finally` 中 callId 卡故意不 `card.remove()`，等 tool result projection 清理，而本插件胜出路径没走那条 projection → 卡残留。核实 DSH 无公开撤卡 API、host→client 无实时推送轮子（Remote Event 白名单锁死、connection 纯 RPC）。
- **修复**：
  - host 在 `resolveQuestions` 胜出时按 callId 记录 settled（5 分钟窗，`settledQuestions`），新增 `/settled` 路由暴露已结算 callId 列表。
  - client 每 2 秒轮询 `/settled`，对 uiSession 快照中 `it.callId` 命中的残留卡调非官方 `PendingQuestion.dismiss()`（callId 卡走 hide 分支撤出 composer 座），软判 `typeof==='function'` + try/catch + 按 callId 精确匹配 + 幂等。
  - **注意**：`dismiss()` 非官方 API，需真机确认 hide 撤卡干净。

## 验证

- `node --check` 五模块通过。
- `node smoke/smoke-test.mjs` → **99 项断言全部通过**（新增：回填后 settled callId 记录、client 按 callId 精确 dismiss 且幂等、/settled 路由、宿主计时准点/取消/去重等回归；历史 m00006/m00497/m00564/m00713 全部保持绿）。
- `npm pack` 26 文件通过，tar 核验含全部修复标记。

## 已知边界

- `PendingQuestion.dismiss()` 为非官方内部 API，DSH 升级可能变动；已做软判 + try/catch 降级，最坏情况卡仍需用户手动关。
- 宿主计时依赖 client 在入批时预约（client→host HTTP）；若 client 完全未加载，仍退回原超时提醒链路。
- 版本号由用户拍板升至 2.2.0；本发布说明随版本包发布，实际 npm/GitHub/Gitee 发布动作需用户另行确认。
