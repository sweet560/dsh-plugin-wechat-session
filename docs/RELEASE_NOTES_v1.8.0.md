# v1.8.0 发布说明（选项1：多个 DSH 会话 ↔ 单一微信实时交互）

发版日期：2026-11-13
npm 包：`dsh-plugin-wechat-session@1.8.0`
仓库：GitHub `sweet560/dsh-plugin-wechat-session` / Gitee `wtt520wyl/dsh-plugin-wechat-session`

---

## 这个版本做了什么

目标来自用户需求原话：「把多个 dsh 会话 跟 单一微信号（微信 clawtbot） 联通，可以直接在微信上 时时交互」。

源码调研先确认了一个硬约束：dsh-im 的微信通道本质「**一个私聊 ↔ 一个 DSH 会话**」1:1——

- `state-store.mjs`：`sessions` 是 `{'p2p:<userId>': sessionId}` 单值 map，一个 key 一个值；
- `delivery-suggestions.mjs:212-221` `resolveConversationKey()`：一个目标匹配多个会话就返回 `null`；
- `delivery-adapter.mjs:364` `syncTarget()`：`sessions[conversationKey] === sessionId` 才放行；
- `bot-workspace-store.mjs:206-212` `normalizeDeliveryTarget()`：强制单个 `sessionSync.conversationKey`。

所以**同一个微信私聊任一时刻只能绑定一条 DSH 会话**，「多会话同时并行双向同步」在现有实现里做不到；微信也不向插件自发消息开放入站订阅（`consumeInbound` 只对飞书 / Lark 开放）。硬做要改 `node_modules/@xmanrui/dsh-im` 核心，升级即丢，违背「不重复造轮子」。

按开发准则采用**选项1：全会话实时分标签推送 + `/session` 串行切换**，全部复用现成能力、不改 dsh-im 核心：

### 1. 下行：全会话实时分标签推送

- 设置页新增「多会话 · 实时推送（选项1）」卡片，含 `realtimePush` 开关（**默认关**，关掉时行为与 v1.7.0 完全一致、零副作用）与「测试实时推送」按钮。
- 开启后，`evalUiStatus()` 在 question / approval / done 三个状态边沿，除原有「浮层卡 + 超时批次」外，各自**立刻**再调一次 `pushRealtime()`，把一条极简微信推到同一个私聊：
  - 三类卡同款骨架（首行状态 + 时间、行间空行分段、/session 切换、统一脚注），title 留空整段作 desp（避免 Host 在标题与正文间插空行）。微信会把单个换行折叠成空格，故各段以「行间空行」拼成一条消息强制分段。
  - 「需要选择 / 授予权限」卡：DeepSeek Harness · 会话「XXX」【 需要选择 】 HH:MM:SS / ▸ 在微信里发送： / /session session-xxxx  / 即可切到该会话继续对话。  / 📌 正文：具体问题（textFromPayload 截取） / 选项N：内容（从 questions[0].options 读真实编号选项，每项独立成段，无选项则不列） / —— 本条为实时状态提醒，勿在此回复 ——。「授予权限」把标签换成【 授予权限 】。去重指纹取「会话 + 事件 + 会话名 + 具体问题 + 编号选项」，不含时间。
  - 「任务完成」卡（6 段定制模板，逐字）：DeepSeek Harness · 会话「XXX」【 已完成 】 HH:MM:SS / ▸ 在微信里发送： / /session session-xxxx  / 即可切到该会话继续对话。  / 📌 正文：任务已跑完，切过去查看回答全文 / —— 本条为实时状态提醒，勿在此回复 ——。时间为发出时刻；去重指纹 sid + kind 不含时间，跨秒抖动不重复发。
- 任一会话一有动静，微信里马上分标签可见，**不用等 60 / 30 秒超时**。子代理会话仍静默；首次基线 `evalUiStatus(true)` 不补发历史；推送失败只写 warn，不影响主链路。

### 2. 上行：`/session` 串行切换，回答全文交 dsh-im 双向同步

- `/session <会话ID>` 是 dsh-im 原生入站命令（`workspace-command.mjs` 的 `SESSION_BIND_COMMAND`），`uiSession` 的 `sid` 即 `sessionId`、无空格可直接作参数。
- 用户在微信里发 `/session <另一条会话ID>` 即可把该私聊切到那条 DSH 会话继续聊；配合 dsh-im 设置里「双向同步 + 投递模型回答」，该会话的模型回答全文会回投到微信——形成闭环。切换只改绑定，旧会话保留、可再切回。
- 「哪个会话 / 什么状态」用现成 `uiSession.sessionStatus` + `sessions.list`；「回答了什么」沿用 dsh-im 双向同步，**不在客户端自建全会话回答全文拉取**（那需要按 sessionId 调 `session.history` 内部 RPC 或改 Host 订阅 `session/event`，升级即丢、会与页面重复投递）。

### 3. 投递链路零改动

- `sendWechat()` 拆成低层 `postWechat(note)`（原 fetch 全文：仍是**唯一** `fetch`，走 Host `/__dsh-plugin-wechat-session/wechat`，body 仍是 `{title, desp, botId, targetId}`）与带门禁的 `sendWechat()`（保留 v1.7.0 的 `!cfg.enabled || !cfg.wechatEnabled` 短路）。
- `pushRealtime()`、设置页 `testRealtime`、全局 API `testRealtime()` 全部复用 `postWechat()`，不新增第二个 fetch、不改 Host 半边（`lib/index.js` 仅把 `VERSION` 升到 1.8.0）。
- `wechatSyncGuide` 补「开启双向同步并投递模型回答」与「多会话靠 `/session` 串行切换」两段指引；`debug()` 增加 `realtimePush` 字段。

### 4. 验证

- `node --check lib/client.js lib/index.js` 通过（英文文案曾因 `session's` 单引号触发 `SyntaxError: Unexpected identifier 's'`，已改为 `the full answers of the bound session` 修复）。
- `node smoke/smoke-test.mjs` → **全部通过：57 项断言**（54 项旧断言零漂移 + 3 组新断言）：
  - ① 源码级：默认关 / `postWechat` / `summarizeRealtime` / `pushRealtime` / `/session {id}` / `groupRealtime` / `testRealtime` 齐备；
  - ② 行为级：开启后 question 边沿立刻 +1 条，desp 含会话名、会话 ID、`/session sRT`；
  - ③ done 边沿 +1 条、子代理静默、`realtimePush=false` 后不发。
- 版本同步：`package.json` / `lib/index.js:23 VERSION` / `lib/client.js` 设置页页脚 / `README.md` / `README.en.md` / `locale/*.json` / `CHANGELOG.md` / `smoke/smoke-test.mjs:23`。

---

## 升级与使用

1. 本插件是 `file:` 本地源码，改完源码需同步进 profile 副本（remove + add，见 README 第 5 节）才会生效。
2. dsh-im 设置 →「通用设置 → 投递」打开**双向同步**与「**投递模型回答**」。
3. 本插件设置页填好 Bot ID / 目标 ID，打开「**全会话实时推送**」，点「测试实时推送」确认能收到。
4. 微信里收到任意会话的实时推送后，按其中的 `/session <会话ID>` 发一条即可切过去继续聊。

> 边界提醒：多个会话是**串行**共用单一微信号（任一时刻微信私聊绑定一条会话），不是「同时并行」。这是 dsh-im 微信通道的数据结构决定的，不是本插件的限制；要真正并行需改 dsh-im 核心，不在本版本范围。
