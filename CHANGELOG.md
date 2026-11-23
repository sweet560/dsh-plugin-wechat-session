# 更新日志

本文件记录 dsh-plugin-wechat-session（微信会话互通）的版本更迭。
全部条目用中文书写。

## v2.2.2（2026-11-23）— 选择题定期提醒（用户指定 patch 递增）

本轮为小功能版本，新增「选择题定期提醒」机制：用户与微信端均未操作时，每隔一段时间在微信再次推送一条带选项与回填码的提醒，避免选择题迟迟未操作却只等来超时提示。插件仍不接管会话生命周期。

- **新增【选择题定期提醒】**：复用审批（ApprovalRegistry）已有的提醒机制范式。选择题此前只有 5 分钟硬超时、无任何提醒；现新增 `questionRemindIntervalMs`（默认 60s，回落 `remindIntervalMs`）与 `questionMaxReminders`（默认 3，回落 `maxReminders`）。每到期推一条 `[提醒] 选择题仍待选择` 文本，含问题、编号选项与回填码（单题 `前缀 1A`、多题 `前缀 1A 2B`）。到顶只停提醒、不自动跳过，5 分钟硬超时才关闭回填；任一端（微信回填 / DSH 手选）作答立即通过 `clearQuestionReminder` 停提醒。在 `finish` / 超时 / UI 胜出 / dispose 四处均清理定时器，杜绝泄漏。
- **全量文案同步**：README.md / README.en.md / 设置页 i18n（locale zh/en）/ package.json description / lib/index.js VERSION / client 关于页版本号均更新为 v2.2.2。
- **验证**：`node --check` 五模块通过；`node smoke/smoke-test.mjs` → **99 项断言全部通过**（新增 2 条 m02017 断言：提醒准点发 3 次且含选项/回填码、回填后停提醒；历史 m00006/m00497/m00564/m00713/m01072/m01709 修复全绿，路由数 9 条）。

## v2.2.1（2026-11-23）— 撤卡改用官方 answer()，去除非官方 API 依赖（用户指定 patch 递增）

本轮为小修复版本，把「微信回填后撤掉 DSH 原生选择卡」的实现从非官方 `PendingQuestion.dismiss()` 轮询彻底改为官方 `userQuestions.answer()`，去掉了对非官方 API 的依赖。插件仍不接管会话生命周期。

- **架构级【撤卡改用官方 answer()】**：核实卡残留真正根因是时序错配——窗口内回填（state=open）由 tool/result 自动 settle，卡本就消失；超时后晚到（state=continued）插件只 resolve 内部 decision，未走会产生 settle 事件的通道，投影停在 continued 导致卡残留。官方 `userQuestions.answer()` 正是为 pending 晚到设计：steer 一条 `source.kind='user-question-reply'` 消息命中投影 `user/message` 分支（不查 state、按 callId settle）。修复：host 回填胜出时按 callId/agent/答案调官方 `ctx.get('userQuestions').answer()`（try/catch、失败不影响回填；open 态返回 false 由 tool/result 自动 settle，两态互斥不重复结算）。
- **清理非官方机制**：删除 client 每 2 秒的 dismiss 轮询（`dismissedSettled`/`settledPollRequest`/`dismissSettledCards`/`settledTimer`）、host settled 队列（`settledQuestions`/`SETTLED_WINDOW_MS`/`getSettledQuestionIds`）、`/settled` 路由（`SETTLED_ROUTE`/`settledHandler`）。不再依赖任何非官方 `PendingQuestion.dismiss()`。
- **全量文案同步**：README.md / README.en.md / 设置页 i18n（locale zh/en）/ package.json description / lib/index.js VERSION / client 关于页版本号均更新为 v2.2.1。
- **验证**：`node smoke/smoke-test.mjs` → **97 项断言全部通过**（新增「回填胜出后调官方 answer()」回归，含 callId/agent/答案精确断言；此前 m00006/m00497/m00564/m00713/m01072 修复全绿，路由数 9 条）。

## v2.2.0（2026-11-23）— 回填/计时根治 + 原生卡残留清理（用户指定 minor 递增）

本轮为纯修复版本，聚焦真机验证中暴露的回填误投、通知延迟、卡片残留等问题，其中通知计时改为宿主 Node 定时器属架构级调整。插件仍不接管会话生命周期。

- **修复【微信回填码误投到已绑定会话】**：根因是 DSH `ctx.waterfall` 为链式 `next()`，原生 UI 应答器（`dsh-client-ui-user-questions`）pending 等点击且不调 `next()`，本插件 listener 默认排在链尾导致回调永不执行、待决池为空，回填码掉进自由对话误投 activeSession。修复：waterfall 应答者注册加 `prepend:true` 抢占链首；新增 `looksLikeQuestionReply()` 防御底座——形似 `<前缀> <数字+字母>` 的文本绝不投给 activeSession，而是按前缀反查全会话（`resolveSessionByPrefix`）结算或明确提示"无待决选择题"。
- **修复【未绑定会话 DSH 手动选择无反应】**：prepend 后硬超时曾以空答案 `finish()` 抢先 settle Promise.race，导致用户随后在 DSH 界面手选无人接收。修复：未绑定会话（有原生 UI 经 `next()` 兜底）超时只让微信回填失效、交回手选；绑定会话无兜底仍 fail-closed 回空答案。
- **修复【正文已到仍发重复完成卡】**：正文镜像（host 半边 `onAssistantStream`）与完成卡（client 半边 uiSession 边沿）是两条独立通道，各发一条。修复：host 发正文按 sid 打时间戳，client 发卡带 kind+sid，`/wechat` 出站口统一拦截——done 卡若对应会话近期（默认 300s）发过正文就吞掉；未绑定会话无正文镜像仍保留完成提醒。
- **架构级【宿主计时根治微信通知延迟】**：原批次计时用浏览器渲染进程 `setTimeout`（后台被 Chromium 节流到分钟级），窗口获焦点才补发。修复：新增 `/notify-clock` 路由 + 宿主 Node 定时器，client 在事件边沿把"卡片内容+截止时间+dedupeKey"预约给宿主准点发卡，已响应时事件驱动取消；宿主与 `/wechat` 共用 `deliverCard()` 与 60s dedupeKey 去重杜绝双发。client 本地批次逻辑保留（兼容既有断言），桌面通知仍即时弹。
- **修复【微信回填生效但 DSH 原生选择卡残留】**：本插件 prepend 胜出后，原生 UI 应答器的 callId 卡仍 pending 等点击不消失。核实 DSH 无公开撤卡 API、host→client 无实时推送，唯一入口是非官方 `PendingQuestion.dismiss()`（callId 卡走 hide 分支）。修复：host 在 `resolveQuestions` 胜出时按 callId 记录 settled（5 分钟窗），新增 `/settled` 路由，client 每 2 秒轮询已结算 callId 并对命中的残留卡调 `dismiss()`（软判 + try/catch + 按 callId 精确匹配 + 幂等）。需真机确认 hide 撤卡干净。
- **全量文案同步**：README.md / README.en.md / 设置页 i18n（locale zh/en）/ package.json description / lib/index.js VERSION / client 关于页版本号均更新为 v2.2.0。
- **验证**：`node --check` 五模块通过；`node smoke/smoke-test.mjs` → **99 项断言全部通过**（新增 settled callId 记录、client dismiss 精确匹配幂等、/settled 路由、宿主计时准点/取消/去重等回归；历史 m00006/m00497/m00564/m00713 全绿）。`npm pack` 26 文件通过，tar 核验含全部修复标记。

## v2.1.0（2026-11-20）— /new 薄创建会话 + 工作目录可配

在 v2.0.0「通道外设」基础上新增会话薄创建能力（用户明确指定 minor 版本）。插件仍不接管会话生命周期：`/new` 只调一次 DSH 官方 create + rename 拿 sessionId 立即当绑定目标，不维护会话池、不自动清理、不做映射表。

- **`/new` 薄创建会话**：微信发 `/new` 或 `/new <标题>` —— 在设置页指定的工作目录新建会话，随后自动 `/use` 绑定，可直接开始对话。create/rename/resume 与 prompt 同为 `@Remote` 方法，均走 `ctx.get` 软获取（严格 inject 安全）。
  - **修复【新建会话落到「未分组」】**：真机发现只传 `cwd` 的会话不属于任何 workspace、列表显示「未分组」（asar 契约：`cwd` 与 `workspaceId` 互斥，`cwd` 只是「未指定 Workspace 时会话拥有的目录」）。改为先把工作目录经 `workspaceController.create({ path })` 注册/幂等解析成 workspace 拿 `workspaceId`，再 `sessionController.create({ workspaceId })`，确保会话进入对应工作区分组；无 workspaceController 时才退回 `cwd`。
  - **修复【标题没带「微信 · 」前缀】**：自定义标题（如 `/new 甜屿林风1`）现统一加「微信 · 」前缀（已带则不重复），缺省为「微信 · Clawbot」。按 `rename` 契约（`Rename one Session after explicitly resuming it.`）改为 create 返回真实 sessionId → `resume({ sessionId })` → `rename({ sessionId, title })`。固定标题仍可能被 DSH 首条 prompt 后的自动标题覆盖，之后重命名由 DSH 负责（用户已接受）。
- **工作目录可配并持久化**：设置页新增「新建会话（微信 /new）」卡，输入即自动 POST 到宿主 `/settings` 路由并写 localStorage（真机发现旧「点保存才写」导致 `settings.json` 为空、`/new` 拿不到目录）；持久化到零依赖 `lib/host/settings-store.js`（`~/.dsh-plugin-wechat-session/settings.json`，mode 0o600、坏文件静默降级）；设置页挂载时 GET 回读权威值，底部保留保存按钮兜底。`cfg.settingsFile` 可覆盖路径（测试用）。
- **修复【任意会话的审批/选择题回填误投】**：真机反馈富格式选择卡回 `91b21f 1A 2B` 跑到了「甜屿林风1」会话——根因是富格式卡由 client 半边对所有会话发，但 host 的 `approval/request` / `user-questions/request` 应答者此前只服务已 `/use` 绑定的会话，未绑定会话前缀不被识别、掉进自由对话分支误投。asar 实证 `ctx.approval` 无「按 callId 事后回填」接口（决策只能由 waterfall 应答者当场返回，原生 UI 亦然），故改为：应答者去掉「仅绑定」过滤（任意会话都注册待决），前缀反查范围扩大到「待决池」（绑定 + 审批 pending + 选择题 pending）；绑定会话保持微信独占（不调 `next()`，不回归「微信只要一套卡」），未绑定会话传 `next()` 与原生 UI 应答器**竞答**（`Promise.race`，谁先 settle 谁定案，另一方幂等撤销）。边界：竞答下先答者定案、另一方卡片可能残留（DSH waterfall 链式 veto 机制决定，无法无感同步）。
- **全量文案同步**：README.md / README.en.md / 设置页 i18n（loginHint / sectionHintShort / sectionHint / aboutFeatureText / newSessionCwdHint）/ package.json description / cordis.patch.yml 均补上 `/new`、工作区分组与 v2.1.0 说明（吸取以往遗漏文案的教训）。
- **错误提示中文化**：真机发现底层 DSH 的英文错误（如 `session "..." not found`）被原样转发到微信，用户看不懂。新增零依赖 `humanizeError()`（lib/host/bridge.js）：命中 `not found` / `without inject` / `timeout` / `unavailable` / `permission denied` / `invalid json` 等常见英文错误时转成中文（如「找不到该会话（可能已被删除或 ID 不对）」），已含中文的原样保留、未知英文原样保留；接入所有发往微信的错误分支（新建会话失败 / 按标题解析失败 / 会话未接受消息 / 转交失败 / 列举会话失败 / 工作目录注册失败 / 创建会话失败）。
- **正文镜像改用可读标题抬头**：真机反馈 agent 回复前的 `[短码]` 前缀（如 `[2f7b63]`）用户看不懂。正文镜像（onAssistantStream 最终回复 + onSessionEvent 非 assistant 事件）改为以 `DeepSeek Harness · 会话「标题」` 抬头再跟正文，标题走 `sessionQuery.readTitle` 软获取（ctx.get 严格 inject 安全），读不到时退回短码。审批/选择题回填卡、错误、提醒仍用 `[短码]` 作回填码（回填必需），不受影响。
- **修复【归档会话发消息静默入队】**：真机反馈绑定的会话归档后，微信发消息仍「正常发出」却无人处理。asar 实证宿主 `sessionController.prompt` 入口不检查归档（归档闸门在 `agent/pre-step`），归档会话本体仍在持久化中，prompt 会把消息静默入队。`submitPrompt` 在投递前先用 `ctx.get('workspaceRegistry').archivedSessionIds` 检查（Set/数组都兼容，软获取降级），命中则明确回「该会话已归档或已删除，无法发送消息。请用 /use 绑定其它会话， /new 创建新会话。」（同时引导绑定其它会话与 `/new` 新建），不再静默入队；真删除的会话 prompt 抛 `session "..." not found` 仍由既有 catch 中文化提示。
- **修复【归档/删除会话误弹「对话完成」提醒】**：真机反馈归档或删除一个会话时，也会弹「对话完成」浮层并推微信富格式卡（各 2 次）。根因是归档/删除会同时引发 `running` 边沿与 `completionUnread` 上升沿，`noteAlert()` 只看 sessionStatus 无从分辨会话已失效。修复在 `noteAlert()` 唯一入口（一处覆盖弹窗 + 提示音 + 30 秒微信批次）加 `isArchivedOrDeletedSession()`（lib/client.js）：用 `ctx.get` 软获取 `workspaces` / `sessions`，归档判据取 `workspaces.list.getSnapshot().archivedSessionIds`、删除判据取 `sessions.list.getSnapshot().ids`（对齐宿主 dsh-client-ui-schedule 的 sessionLinkState；**不能用 byId**——它保留 local fallback 行）；两个信号走软获取、只在「明确证明」归档/删除时静默，未就绪/空列表时保持原行为，避免启动竞态误伤。
- **验证**：`node --check` 五模块通过；`node smoke/smoke-test.mjs` → **89 项断言全部通过**（新增 `/new` 解析、薄创建默认标题兜底 + 自定义标题 + 立即绑定 + 无解析器降级、settings-store 读写 + 坏文件降级、`/new` 端到端（工作目录→workspaceId 进分组 + 标题加「微信 · 」前缀 + resume→rename + 立即绑定）、8 条路由含 `/settings`、任意会话回填回归（未绑定选择题前缀回填 + 审批竞答 UI 先答透传 + 未绑定审批微信回填）、归档会话拦截（归档后发消息不投递 + 明确提示）、归档/删除会话误弹提醒静默（archivedSessionIds 命中 + 不在 sessions.list.ids，approval + done 均不弹窗/不起批次/不发微信，且普通会话不误伤），历史回归全绿）。

## v2.0.0（2026-11-20）— 通道外设化：去 dsh-im + 双向多会话并行审批

破坏性架构重构（用户明确指定 major 版本）。插件从「依赖 dsh-im 聚合包」彻底转为**独立运行的微信通道外设**，不自行创建会话、不接管会话生命周期，只按用户在微信里显式指定的会话读写事件（绑定会持久化、重启免重绑）。

- **去掉 dsh-im 核心**：删除 `@xmanrui/dsh-im` 运行时依赖与 cordis.patch.yml 中的第二条 loader（含防重挂载守卫）；顶层 `dependencies` 清空；不再有 Bot ID / 目标 ID / `botId`/`targetId` 服务端兜底，改扫码登录。
- **扫码二维码内嵌显示**：iLink 返回的 `qrcode_img_content` 是二维码网页 URL（text/html）而非图片字节，旧实现当 base64 解码导致破图。Host 侧用内置 vendor 的纯 JS 二维码库（`vendor/qrcode.cjs`，MIT，零 npm 运行时依赖）把 URL 编码成 GIF 直接内嵌到设置页 `<img>`，不跳转外链；`qr.png` 路由返回 `image/gif`。
- **三模块架构**（彼此只经宿主 seam 通信，不 import dsh-im 内部）：
  - `lib/channel/ilink.mjs`：纯 iLink 协议客户端（移植自 gtaifu/dsh-wechat-bridge，对照官方 SDK 2.4.6，零运行时依赖，Node 18+ 内置 fetch）。扫码 → 长轮询收消息（35s，游标持久化）→ typing → 发文本，token 失效（errcode=-14）重扫。
  - `lib/channel/transport.js`：纯 iLink 适配器，状态持久化到 `~/.dsh-plugin-wechat-session/ilink-state.json`（mode 0o600），typingTicket 24h 缓存；不 import 任何 DSH 包，可独立测试（fetchImpl 可注入）。
  - `lib/host/bridge.js`：宿主侧 `SessionEventBridge`（只读订阅 `session/event`，仅对显式绑定的会话投递 `[前缀] 文本`）与 `ApprovalGate`（注册为 `approval/request` waterfall 应答者，回调内 await 微信回复再返回决策，未绑定会话交回下一个应答者，fail-closed 由 DSH 保证）。
- **双向多会话并行审批（核心增量）**：微信发 `/use <会话ID>` 显式绑定会话（短前缀取 sessionId 有区分度片段，跳过 `session-` 公共开头后取 6 位，如 `session-91b2175-…` → `91b217`，详见下方「修复【前缀碰撞】」），`/release` 全释放、`/list` 查看绑定、`/help` 帮助；审批卡带前缀，微信回 `3f2a=1` 批准 / `=0` 拒绝 / `=c` 取消，精确投递到该会话的最旧待决请求。每个审批独立并行，绕开 dsh-im「一个私聊只能绑一个会话」的串行限制。回复不带会话前缀或前缀未知 → 提示明确指定，不猜「最近一个」。
- **延迟提醒**：审批等待期间每 `remindIntervalMs`（默认 60s）发微信提醒卡，最多 `maxReminders`（默认 3）次；硬超时 `approvalTimeoutMs`（默认 300s=5分钟，留足「浮层超时→富格式卡到微信→回填」整段窗口）与提醒耗尽后按 `permissionPreset`（`ask` 取消 / `allow-once` 批准一次 / `reject` 拒绝）自动降级结算；`summaryIntervalMs`（默认 0 关闭）可定时汇总未决请求。定时器全程 unref。
- **对话入站（自由聊天）**：微信普通文本经 `handleInbound` 的 passthrough 分支投给最近 `/use` 绑定的固定会话，走官方 `ctx.sessionController.prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text}], clientTimeZone }, signal)`——与网页聊天框"发送"同一入口，不创建会话、不碰 dsh-im；agent 回复由现有 `agent/assistant-stream`（live 正文）+ `session/event` 订阅镜像回微信，构成完整回路。未绑定时提示先 `/use`。转交成功后**不再发「已转交会话，等待回复…」中间回执**（真机反馈该提醒多余、刷屏），agent 正文镜像回来即反馈；失败仍按前缀给出明确错误。
  - **修复【cordis 严格 inject】**：真机反馈「转交失败：cannot get property "sessionController" without inject」——未声明依赖用 `ctx.sessionController` 属性访问会直接抛错、短路求值连 `ctx.get` 都走不到。改为 `ctx.get('sessionController')` 软获取 + try/catch 兜底，加 smoke 回归（模拟属性访问抛错时仍走 `ctx.get` 成功转交）。
  - **修复【设置页登录态】**：真机反馈每次打开设置页显示「未登录（idle）」、点刷新才变「已就绪」。组件挂载时用 `React.useEffect?.(refreshLoginStatus, [])` 自动拉一次 `/login-status`（可选链兼容测试桩）。
- **对话出站（live 流式）**：dsh 0.1.5 起 live 模型正文离开 `session/event` log，改走 `agent/assistant-stream` 帧——真机反馈「DSH 会话有回复但微信收不到」即此因。新增 `onAssistantStream` 订阅，按 `sessionId|attemptId` 聚合 `text-delta`（跳过 `reasoning-delta` 思考过程），`end` 帧一次性投递微信（带会话前缀），避免逐分片刷屏；只处理显式绑定会话，丢弃乱序 revision。与入站合起来构成「微信发消息 → DSH 会话收到并回复 → 回显微信」完整闭环。
  - **修复【思考过程逐条发微信】**：真机反馈「工具循环里的中间播报（『我先查一下源码…』）也被逐条发到微信，应该只发最终回复」。根因确证：一次 turn 若调用工具会产生多个 attempt，`end` 帧的 `outcome.eventType` 为 `assistant/attempt`（中间播报）或 `assistant/message`（最终回复），旧逻辑对每个 `end` 都投递。现只在 `outcome.kind==='committed' && outcome.eventType==='assistant/message'` 时投递，`assistant/attempt`（中间播报）、`abandoned`（放弃）、无 outcome 一律跳过；同时让 `onSessionEvent` 跳过所有 `assistant/*` 事件（post-commit durable feed 会重复 append 这些事件，避免重复投递最终回复或漏出中间播报），正文呈现完全交给流式通道精确判定。smoke 补三类跳过回归。
- **按标题短名绑定**：真机反馈「输入全 ID 太长」——`/use` 支持中文「绑定 <会话标题>」与含空格/`·` 的标题；宿主侧用 `ctx.sessionController.list` 列举会话 + `ctx.sessionQuery.readTitle` 逐个读标题，按「精确 > 前缀 > 包含」匹配，唯一命中直接绑定，多命中回候选列表让用户消歧，未找到给提示；全 ID `/use <完整ID>` 保留兼容。两者都走 `ctx.get` 软获取（严格 inject 安全）。
- **恢复会话列表微信图标**：真机反馈去 dsh-im 后会话列表「微信 · 甜屿林风」退回纯文字（以前前缀会渲染成绿色微信图标）。根因确证：图标只是 dsh-im 客户端纯 DOM 增强（`session-channel-logos.js`，MIT）——MutationObserver 监听会话列表行，用 CSS 伪元素把前缀视觉替换成 SVG 图标，标题文本本身一直是持久化的纯文本。现移植精简版（只微信、保留 MIT 版权声明、零 npm 依赖）到 client 半边：特性检测守卫不满足时保底 noop，预载 Image 成功后接管图标渲染；只加图标、不改标题文本、不建会话、不碰 dsh-im。
  - **修复【图标真机未生效】**：首版虽 77 项断言通过，但 fakeDocument 无 DOM 使图标逻辑一路 noop，存在验证盲区。真 DOM mock 测试揪出三处缺陷：① `[].slice.call(Set)` 无效导致排队的 `update()` 从未运行（元凶，原版用 spread/Array.from）；② observer 漏遍历 `record.addedNodes`，React 增量渲染的会话行不被处理；③ 特性检测把较新的 `attr() / ""` 语法当硬门槛，不支持时整段 noop。已修：改 `Array.from(queued)`、补 addedNodes/removedNodes 遍历、补 searchResultRow 分支、特性检测降为基础 `attr()` 并对 `attr()/""` 做可选增强。验证数增至 78。
- **修复【前缀碰撞】**：真机反馈「前缀是啥」时发现——真实会话 ID 多为 `session-<uuid>`，旧算法去符号取前 6 位会让所有会话都撞成 `sessio`，多会话并行审批无法区分、`sessio=1` 可能误结算。`sessionPrefix()` 改为跳过 `session-` 这类公共开头后取 6 位（`session-91b2175-…` → `91b217`、`session-4bf2c3c3-…` → `4bf2c3`）；非 `session-` 开头的 ID（如 `3f2a9b`）与短 ID 保持原样。审批卡、绑定回执、`/list`、流式回显的前缀全部随之更新，输入 `91b217=1` 即可精确批准对应会话。
- **选择题回填（ask_user_question）**：真机反馈「两道题各三个选项的选择卡在微信里怎么回」——审批卡的 `=1/=0/=c` 只针对工具审批；ask_user_question 选择题的选项由调用方自定义，此前微信侧未接故回复无效。新增订阅 `user-questions/request` waterfall（与审批对称，回调返回的 `AskUserQuestionAnswer` 即回填，不重复调 answer 服务）：微信卡片格式参考页面「需要选择」通知——`[需要选择] [前缀] 共 N 题` + 逐题正文 + `A/B/C` 编号选项；微信回 `<前缀> 1A 2B`（多选如 `<前缀> 1AB`）后按「题号 + 字母」映射到每题 option 的 **label 字符串数组**（`AskUserQuestionAnswerItem.selected` 要的是 label 不是序号），精确回填对应会话。多会话靠前缀区分、并行互不干扰；未绑定会话返回 `undefined` 交回 waterfall，带 `intent`（approval/plan-review）的题跳过交回审批链路避免冲突；`questionTimeoutMs`（默认用 `approvalTimeoutMs`）到点回填空答案 fail-closed。`/help` 补选择题回复说明。
- **富格式卡绑定指令改为「前缀 + 标题」两行**：真机反馈卡里一整行完整 sessionId（如 `/use session-ae2c0c79-…`）太长难输入。现把该行换成两行——`/use <前缀>` 与 `绑定 <会话标题>`（前缀取会话短前缀、标题取会话实际显示名，均按触发的会话填入）。配套：client 半边补与宿主一致的 `sessionPrefix` 算法（同样跳过 `session` 公共开头防碰撞）；宿主新增 `resolveSessionByPrefix`（经 `sessionController.list` 列全部会话 + 逐个算前缀精确反查），让 `/use <前缀>` 真能绑定尚未绑定的会话，反查不到时回退字面绑定以兼容完整 ID。卡片的 `绑定 <标题>` 复用既有 use-title 分支，两行都真能用。
- **绑定状态持久化**：真机反馈「前面绑定了，接着输入又变成没绑定」——根因是绑定集合与活跃会话都只存在内存（bridge `explicitSessions`/`activeSession`），插件实例一旦重建（重启 / remove+install / HMR 重载）就归零，并非功能损坏。新增零依赖 `lib/host/binding-store.js`（与 iLink state 同目录 `~/.dsh-plugin-wechat-session/bindings.json`，mode 0o600、坏文件静默降级），bridge 启动时 load 恢复绑定集合与活跃会话，bind/release 时 save 写回；恢复时校验活跃会话必须仍在集合内，避免幽灵目标。以后重启/重装后无需重新 `/use`。`cfg.bindingFile` 可覆盖路径（测试用）。
- **富格式卡成为微信唯一可回填卡**：真机反馈希望「微信里只要一套卡、在 DSH 浮层超时未处理后才触发，且这张卡本身就能回填」。现停发 host 侧即时的 `[审批请求]` / `[需要选择]` 短卡（待决注册 `registry.register` / `questionPending.set` 全部保留，回填链路不变），微信侧交互统一由 DSH 浮层超时后发出的富格式卡承担；配套把富格式卡做成可直接照抄的回填卡：① 脚注按卡片类型拆开——「需要选择」写实际前缀 + `<前缀> 1A 2B`（多选 `<前缀> 1AB`）、「授予权限 / 计划审阅」写实际前缀 + `<前缀>=1/0/c`，不再用文不对题的审批话术；② 选项编号从「选项1/2/3」改为可直接回填的字母 `A/B/C`；③ 回填硬超时从 120s 提到 300s，确保浮层 60s 超时后卡片到微信仍有充足时间回填。
- **保留**：应用内浮层卡 + 提示音、双超时富格式卡、设置页卡片式分组与草稿保存。
- **验证**：`node --check` 五模块通过；`node smoke/smoke-test.mjs` → **81 项断言全部通过**（清单契约、bridge 单测含前缀碰撞回归、`/use <前缀>` 反查绑定 + 失败回退、绑定状态持久化启动恢复 + bind/release 写回 + 幽灵目标防护、选择题解析/字母→label 回填/多选/intent 跳过、停发即时短卡仍保留待决注册、7 条 Host 路由 + 官方 seam 含 user-questions/request、扫码登录全流程、多会话并行审批、对话入站 + 严格 inject 回归、出站流式聚合、按标题绑定四分支 + 端到端反查、iLink 端到端投递、client half 回归、微信图标真 DOM mock 增量渲染、富格式卡七段两行绑定模板 + A/B/C 选项 + 按类型脚注逐字）。

## v1.9.0（2026-11-18）— 功能融合 + 设置页打磨

在 v1.8.0「选项1 实时推送」基础上，按用户要求把两类微信发送功能融合，并对设置页做一致性打磨。全部在本机实测通过后发版。

- **功能融合（取消独立实时推送开关）**：删除设置页「多会话 · 实时推送」卡片与 `realtimePush` 开关（字段保留兼容旧配置，但不再控制行为）；超时微信不再发旧「极简清单」，改发原实时推送的**富格式卡**——任务完成 / 需要选择 / 授予权限三类，含会话名、会话 ID、`/session <会话ID>` 切换命令、具体问题/正文与编号选项。
- **触发时机**：状态边沿（question / approval / done）不再立刻发微信，只起浮层卡 + 超时批次；等对应超时到点（需选择 / 确认 60 秒、任务跑完 30 秒）由 `fireBatchTimeout` 逐条 `pushRealtime()` 发送。`pushRealtime` 门禁由 `realtimePush` 改为 `wechatEnabled`，复用 `summarizeRealtime` 模板与 60 秒去重机制，不重复造轮子。
- **设置页草稿 + 保存**：「微信机器人 / 投递目标」「超时设置」两卡的输入框改为草稿态，卡底新增「保存」按钮，点保存才 `writeConfig` 生效；保存按钮三态（未修改弱化 / 有修改激活 / 悬浮反馈）令牌对齐 `dsh-session-archive` 归档插件，明暗主题自适应。
- **布局收紧**：卡片底部与字段行留白压缩、卡内最后一行去掉底部分隔线，布局更紧凑（行间分隔线保留）。
- 文案同步：package.json 描述 / README（中英）/ locale（中英）/ 设置页关于卡 / `aboutFeatureText` 全部更新为富格式卡 + 功能融合口径；历史 v1.8.0 记录原样保留。
- 验证：`node --check` 通过；`node smoke/smoke-test.mjs` → 全部通过：**63 项断言**（源码级 + 行为级覆盖富格式卡模板、超时触发、门禁、去重、端到端、选项块）。冒烟沿用 v1.8.0 的 57 项并重写触发语义至 63 项。

## v1.8.0（2026-11-13）— 选项1：多会话 ↔ 单一微信实时交互

目标：把多个 DSH 会话跟单一微信号（微信 clawtbot）联通，可直接在微信上实时交互。
源码调研确认：dsh-im 微信通道本质「一个私聊 ↔ 一个 DSH 会话」1:1（state-store.mjs
`sessions['p2p:<userId>']=sessionId` 单值、resolveConversationKey matches>1 返回 null、
normalizeDeliveryTarget 强制单 conversationKey），无法「同时并行」绑定多个会话；
微信渠道对插件自发的消息也不开放入站订阅（consumeInbound 只对飞书/Lark 开放）。
故按「不重复造轮子」采用**选项1：全会话实时分标签推送 + /session 串行切换**：

- 下行（全会话实时）：新增 `realtimePush` 开关（默认关，零副作用）。开启后
  `evalUiStatus` 的 question / approval / done 三个状态边沿，除原有「浮层 + 超时批次」
  外，各自再立刻调一次 `pushRealtime()`，把带**会话名 + 会话 ID + `/session <会话ID>`
  切换命令**的极简微信推到同一个私聊——任一会话一有动静，微信里马上分标签可见，
  不用等 60/30 秒超时。子代理会话仍静默、seed 基线不补发。
- 上行（串行切换）：`/session <会话ID>` 是 dsh-im 原生入站命令，uiSession 的 sid 即
  sessionId 可直接作参数。用户在微信里发 `/session <想要的那条会话ID>` 即可切过去
  继续聊；dsh-im 双向同步（deliverModelAnswers）把该会话回答全文回投——这就是闭环。
  回答全文 / 选项卡全部沿用 dsh-im，不在插件里自建拉取/解析。
- 投递链路零改动：把 `sendWechat()` 拆成低层 `postWechat(note)`（唯一 fetch，仍走
  Host `/__dsh-plugin-wechat-session/wechat` 路由、body 仍是 `{title,desp,botId,targetId}`）
  与带门禁的 `sendWechat()`（保留 v1.7.0 行为）；`pushRealtime` 与新的
  `testRealtime` 都复用 `postWechat`，不新增第二个 fetch。
- 设置页新增「多会话 · 实时推送（选项1）」卡片（开关 + 测试按钮）；
  `wechatSyncGuide` 补「开启双向同步并投递模型回答」与「多会话靠 /session 切换」两段指引；
  `debug()` / 全局 API 增加 `realtimePush` 与 `testRealtime()`。
- 冒烟测试从 54 项扩到 57 项：源码级（默认关 / postWechat / pushRealtime /
  /session 命令 / 卡片 / 测试函数）+ 行为级（开启后 question、done 边沿各立刻 +1 条、
  含会话名/会话 ID/切换命令、子代理静默、关掉开关不发）。

验证：`node --check` 三文件通过；`node smoke/smoke-test.mjs` → 全部通过：57 项断言。

## v1.7.0（2026-11-12）

桌面提醒形态、设置页与微信内容的一次集中整理（相对 v1.6.0）。全部在本机实测通过后发版。

### 桌面提醒：只留「唯一一张应用内浮层卡片」

- 之前每次提醒会同时挂**应用内浮层卡片** + 弹**系统通知横幅**，屏幕上出现两个弹窗。
  按用户决策「只留一个」，删掉整段 `new Notification(...)` 分支：`toast()` 现在只做
  `ensurePermission()` → `showInAppToast()` → `playCue()`。浮层是唯一弹窗，提示音保留。
- 浮层固定在窗口**右下角**（`right/bottom: 16px`），挂在 `document.body` 上、
  `zIndex: 2147483647`，**不依赖系统通知权限**：即使 `Notification.permission` 被拒绝、
  或人停在别的会话界面，也一定看得到；点一下 `jumpToSession(sid)` 切到对应会话，8 秒自动关闭。
- 浮层元素自身带 `title / opts.body / opts.tag / onclick / close() / closed`，
  与旧通知对象接口一致，历史行为断言无需逐条改写。

### 设置页：卡片式分组

- 顶部一大段说明收成一句短副标题 + 一个可展开「展开完整说明」按钮。
- 配置项按 **基础 / 微信机器人·投递目标 / 超时设置 / 提醒方式 / 在微信里直接选择 / 测试**
  分成 6 张卡片，统一圆角、间距、边框、中性配色（兼容深浅色）、主按钮蓝 `#2f6feb` / 次按钮灰。

### 微信内容：双超时 + 极简留底 + 真回填交 dsh-im

- **按事件类别双超时**：「需选择 / 确认」独立 `attentionTimeoutSec`（默认 **60** 秒），
  「任务跑完」沿用 `timeoutSec`（**30** 秒）；每条提醒自带 `deadline`，批次计时器对准
  最早到期项，到点只发已到期项、未到期项留到下一次，两类不串台。
- 超时微信从「问题原文 + 编号选项 + 回复格式 + 绑定长文」的**文字墙砍成极简**：
  【等你处理】/【已完成】两段，只写会话名与事件（done 段突出「会话「XXX」已完成」），
  末尾一句「别在这条下回复」。
- **「微信里回 1 直接选、任务继续」交 dsh-im 原生同步提问**：本插件自己 `ctx.dshIm.send()`
  发的微信结构上收不到回复（`consumeInbound` 仅飞书/Lark 开放），故设置页给出
  `/sessionlist` → `/session <id>` 绑定指引，选项卡由 dsh-im 即时推送并回填；本插件超时消息
  只是留底，明确不要在那条下回复。

### 验证

- `node --check` 三文件通过；`node smoke/smoke-test.mjs` **54 项断言全通过**
  （含新增 m05207①「只留一个弹窗、整轮不再 new Notification」与 m05207②「卡片式分组」）。
- `npm pack --dry-run` = 14 文件；本机实测（重开 DSH 后）：唯一浮层 + 提示音 + 点击跳会话 +
  卡片式设置页全部正常。

## v1.6.0（2026-11-12）

行为修复 + 发布流水线升级 + 市场收录 + **本次改名**。相对 v1.5.0 的变化：

### 本次改名（dsh-session-guardian → dsh-plugin-wechat-session）

- 包名 `dsh-session-guardian` → `dsh-plugin-wechat-session`，中文显示名
  「会话监督联动提醒」→「微信会话互通」。内部标识（HTTP 路由 `/__dsh-plugin-wechat-session/*`、
  localStorage key、全局 API `window.__dshPluginWechatSession`、cordis entry id、
  设置页 id）全部同步。
- 新建 GitHub `sweet560/dsh-plugin-wechat-session` 与 Gitee
  `wtt520wyl/dsh-plugin-wechat-session` 仓库、npm 发布
  `dsh-plugin-wechat-session@1.6.0`；旧仓库 / 旧 npm 包 / 旧市场收录 PR 保留不动。
- **配置三级回退不丢**：新 key 空时逐级回退
  `dshSessionGuardian.config`（上一版）→ `dshWechatReminder.config`（最旧），
  用户已填的 Bot ID / 目标 ID / 超时秒数都保留。

### 行为修复

- **忽略后台委托 / 子代理会话**：Mnemon「自进化」会在后台创建落盘的任务及子代理会话
  （会话名前缀 `[dsh-mnemon:delegated skill]` 这类）。上一版会把它们当成普通对话，
  弹窗、响提示音、30 秒后还补发微信。现在按宿主既有判据（`origin === 'subagent'` /
  `delegationDepth > 0` / `parentId` / 稳定前缀 `[dsh-mnemon:delegated `）在提醒唯一入口
  `noteAlert()` 里静默这类会话——不提醒、不弹窗、也不发微信；普通会话不受影响。
- **治本修复「窗口在后台时需要确认 / 选择却不弹窗也不响」**：`toast()` 原先只在第一次
  用户手势里申请一次 `Notification.permission`，DSH 重开换端口后权限回到 default 就永久不弹；
  且 `silent:true` 关掉系统音、声音全压在会挂起的 WebAudio 上、失败还被空 catch 吞掉。
  现在对齐 dsh-pet：启动即主动申请权限、每次提醒前重试解锁、去掉静音让系统提示音兜底、
  失败写日志，`debug()` 暴露 `notifyPermission / notifySound / audioState / permissionPending`。

### 发布流水线 / 仓库

- `.github/workflows/sync-gitee.yml`（新增）：GitHub `main` 有 push 就自动把 main 与全部标签
  镜像同步到 Gitee（SSH 直推，需仓库 Secret `GITEE_SSH_PRIVATE_KEY`）。
- `.github/workflows/publish.yml`（改为 OIDC 可信发布）：`permissions.id-token: write`、
  Node 24（Active LTS）+ `actions/checkout@v7` / `actions/setup-node@v7` +
  `npm install -g npm@latest`、`npm publish --provenance --access public`，
  **不再依赖 `NPM_TOKEN`**；推 main / 打 `v*` tag / 发 Release / 手动触发时先跑自检，
  再用幂等守卫 `npm view "$NAME@$VERSION"` 判断该版本是否已发布，未发布才发版。
  一次性前提：在 npmjs.com 为 `sweet560/dsh-plugin-wechat-session` 配置 Trusted Publisher
  （Workflow filename 填 `publish.yml`、Environment 留空）。
- 补齐 GitHub 仓库 Topics（10 个），并向 `awesome-dsh-plugin` 提交收录 PR。

### 验证

- `npm test`：离线冒烟测试共 **45 项断言**（含本版两项修复的回归、改名迁移、三类通知、
  会话级规则、整段 JSON 自动拆分、错误中文化、点击跳会话等）。

---

## v1.5.0（2026-11-11）

首个正式发版版本。前身是本机迭代的 `dsh-wechat-reminder`，当时改名为
`dsh-session-guardian`（显示名「会话监督联动提醒」），并建立 GitHub / Gitee / npm
三端仓库与自动发布流水线。（v1.6.0 时又改名为 `dsh-plugin-wechat-session` /「微信会话互通」，见上。）

### 功能总览

- **微信会话互通**：订阅 `uiSession.sessionStatus`，对全部会话做三类边沿检测——
  需要确认权限、需要手动选择、任务跑完（模型这一轮回复结束）。
- **桌面弹窗 + 提示音**：三类事件都弹一张带具体内容的系统通知（标题「会话名 · 事件标签」，
  正文从 `pendingInteraction` 抽出问题文本 / 工具名 + 原因），并播放合成提示音；
  点任意一张通知都切到对应会话界面。
- **微信兜底**：桌面提醒发出后 30 秒内既没切过去看、也没把待办处理掉，就把仍未响应的
  条目汇总成一条微信，经 dsh-im 的微信机器人（普通微信）发到你指定的那一个微信对话。
- **聚合包**：装这一个包就同时带上「微信会话互通」与 `@xmanrui/dsh-im`（微信机器人），
  一个 `insert` 挂两条 loader 行；dsh-im 保留可升级范围、走 npm 官方源。
- **会话级规则**：窗口前台时只提醒「没在看」的那些会话，正盯着的那条保持安静；
  窗口整个切到后台时所有会话都提醒；「有响应」= 切到那条会话去看 / 把待办处理掉。

### 迭代历史（本机阶段，累进到 v1.5.0）

- v1.0.0：三类触发 + 桌面通知 / 提示音 + 30 秒 Server 酱超时补发微信。
- v1.1.0：微信通道去掉 Server 酱，改走 dsh-im 主动投递；设置页改为 Bot ID + 目标 ID。
- v1.1.1：修复「测试微信推送」报 `Invalid target id`——整段「复制调用参数」JSON 自动拆成
  两个纯 ID、旧配置自动清洗、英文报错中文化。
- v1.2.0：升级为聚合包，装一个包带上两个插件；dsh-im 保留顶层 `^5.10.0` 依赖与防重复挂载守卫。
- v1.3.0：修复「3 条会话并行、界面停在一条时其他会话不通知也不发微信」——会话级静音与
  会话级「已响应」判据。
- v1.4.0：去掉重复的空白「DSH 需要你操作」通知；任务跑完通知带会话名；所有通知点击跳会话。
- v1.5.0：三类事件都弹与 dsh-pet 一致、带具体内容的系统通知；点任意通知跳到对应会话。

### 改名迁移（v1.5.0 当时）

从旧名 `dsh-wechat-reminder` 改名重装后，浏览器半边会优先读当时的新 localStorage key
`dshSessionGuardian.config`；若为空则回退读旧 key `dshWechatReminder.config`，
用户已填的 Bot ID / 目标 ID / 超时秒数不会丢失（旧 key 保留不清）。
（v1.6.0 再改名后升级为三级回退，见 v1.6.0 条目。）

### 发布相关

- `.github/workflows/test.yml`：push / PR 时跑离线冒烟测试（Node 24，actions @v7）。
- `.github/workflows/publish.yml`：v1.5.0 时为 `NPM_TOKEN` 版；v1.6.0 起改为
  **OIDC 可信发布（`npm publish --provenance`）**，不再需要 `NPM_TOKEN`。详见 v1.6.0 条目。
