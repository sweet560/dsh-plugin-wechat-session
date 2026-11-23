# v2.0.0 发布说明 — 通道外设版

> 破坏性架构变更（major）。本版本按用户明确指定递增至 2.0.0。

## 一句话

插件不再是「微型 dsh-im」：去掉 `@xmanrui/dsh-im` 核心依赖，独立通过官方 iLink 协议收发微信；不创建会话、不维护「当前焦点」，只做**通道适配器 + 会话引用者**，实现**双向多会话并行审批授权**与**延迟提醒通知**。

## 为什么重构

旧架构的微信通道是 dsh-im 聚合包的一部分，审批/回填能力借 dsh-im 原生同步实现。但 dsh-im 本质是「一个私聊 ↔ 一个 DSH 会话」1:1 绑定，无法并行驱动多个会话，且插件自发消息收不到回复。v2.0.0 把微信通道彻底外设化：

- 通道归通道（iLink 协议 + 扫码登录），会话归 DSH（官方 seam），两者只经显式会话引用耦合。
- 审批决策的所有权始终在 DSH 的 `approval/request` waterfall 上，插件只是它的「远程呈现 + 应答终端」。

## 三模块

| 模块 | 文件 | 职责 | 边界 |
| --- | --- | --- | --- |
| ChannelTransport | `lib/channel/ilink.mjs` + `lib/channel/transport.js` | 扫码登录、长轮询收消息、typing、发文本/媒体 | 纯 iLink 适配器，不 import 任何 DSH 包，可独立测试 |
| SessionEventBridge | `lib/host/bridge.js`（`createBridge.onSessionEvent` + `onAssistantStream`） | 只读订阅 `session/event` 与 `agent/assistant-stream`，仅对显式绑定会话投递 `[前缀] 文本` | 不创建会话、不维护「当前活跃会话」 |
| ApprovalGate | `lib/host/bridge.js`（`createBridge.onApprovalRequest`） | 注册为 `approval/request` waterfall 应答者，卡片带前缀，回调内 await 微信回复返回决策 | 未绑定会话返回 `undefined` 交回下一个应答者，fail-closed 由 DSH 保证 |

## 新增能力

### 双向多会话并行审批

1. 微信发 `/use <会话ID>` 显式绑定要驱动的会话（短前缀取 sessionId 中有区分度的片段：跳过 `session-` 这类公共开头后取 6 位，如 `session-91b2175-…` → `91b217`，避免所有会话都撞成 `sessio`；非 `session-` 开头的 ID 仍取前 6 位，如 `3f2a9b`）；若嫌全 ID 太长，可直接发「绑定 <会话标题>」（如 `绑定 微信·甜屿林风`）或 `/use <标题>`——宿主侧用 `ctx.sessionController.list` + `ctx.sessionQuery.readTitle` 反查：唯一命中直接绑定，多命中回候选列表消歧，未找到给提示。全 ID 绑定始终保留兼容。
   - 富格式卡（任务完成 / 需要选择 / 授予权限）里的绑定指令已改为两行：`/use <前缀>` + `绑定 <会话标题>`（前缀与标题按触发的会话实际填入，替代原来一整行完整 sessionId）。`/use <前缀>` 走宿主 `resolveSessionByPrefix`（`sessionController.list` 列全部会话 + 逐个算前缀精确反查），可绑定尚未绑定的会话，反查不到时回退字面绑定兼容完整 ID。
   - **绑定状态持久化**：绑定集合与活跃会话写到 `~/.dsh-plugin-wechat-session/bindings.json`（零依赖、mode 0o600、坏文件静默降级），启动时自动恢复，bind/release 时写回。DSH 重启 / 插件重装 / HMR 重载后无需重新 `/use`，接着聊即可（恢复时校验活跃会话仍在集合内，杜绝幽灵目标）。`cfg.bindingFile` 可覆盖路径。
2. `/list` 查看已绑定会话与前缀，`/release` 全部释放，`/help` 查看帮助。
3. 任一绑定会话需要审批时，微信收到卡片：`[审批请求] [3f2a] run 原因：… 回复 3f2a=1 批准 / =0 拒绝 / =c 取消`。
4. 微信回 `3f2a=1`（批准一次）/ `=0`（拒绝）/ `=c`（取消），精确投递到该会话最旧的待决请求；决策别名 `1/y/yes/允许/批准`、`0/n/no/拒绝`、`c/取消` 均可。
5. 多个会话的审批**彼此独立并行**，不再受 1:1 串行限制。回复未带前缀或前缀未知时提示明确指定，不猜「最近一个」。

### 对话入站（自由聊天）

- **入站**：微信普通文本经 `handleInbound` 的 passthrough 分支投给最近 `/use` 绑定的固定会话，走官方 `ctx.sessionController.prompt()`（`SessionPromptRequest = { requestId, sessionId, mode:'queue', content:[{type:'text',text}], clientTimeZone }`）——与网页聊天框「发送」同一入口，不创建会话、不碰 dsh-im。未绑定会话时提示先 `/use`。转交成功后不再发「已转交会话，等待回复…」中间回执（真机反馈多余、刷屏），agent 正文镜像回来即反馈；失败仍按前缀给出明确错误。
- **出站**：dsh 0.1.5 起 live 模型正文离开 `session/event` log，改走 `agent/assistant-stream` 帧（`{type:'start'|'chunk'|'end', chunk:{type:'text-delta',text}, attemptId, revision, outcome}`）。`onAssistantStream` 按 `sessionId|attemptId` 聚合 `text-delta`（跳过 `reasoning-delta`），`end` 时一次性镜像回微信（带会话前缀），组成「微信发消息 → DSH 会话收到并回复 → 回显微信」完整闭环。一次 turn 若调用工具会有多个 attempt，只有 `end` 帧 `outcome={kind:'committed',eventType:'assistant/message'}` 的是最终回复；`assistant/attempt`（工具循环中间播报）、`abandoned`、无 outcome 一律不投递。`onSessionEvent` 同步跳过所有 `assistant/*` 事件（post-commit durable feed 会重复 append，交由流式通道精确判定），确保微信只收到最终回复、不逐条播报思考过程。

> 真机修复记录：① cordis 严格 inject 下，未声明依赖用 `ctx.sessionController` 属性访问会直接抛 `cannot get property "sessionController" without inject`（短路求值连 `ctx.get` 都走不到），已改为 `ctx.get('sessionController')` 软获取 + try/catch；② 设置页挂载时未自动拉 `/login-status` 导致初值总显示「未登录」，已加 `React.useEffect?.(refreshLoginStatus, [])`；③ 首版只订阅 `session/event` 导致「DSH 有回复但微信收不到」，已补 `agent/assistant-stream` 流式订阅；④ 真机反馈「思考过程被逐条发到微信」，根因是每个 attempt 的 `end` 都投递，已改为仅 `committed/assistant/message` 投递、中间播报/放弃/无 outcome 全部跳过，并让 `session/event` 跳过 `assistant/*` 防重复。

### 选择题回填（ask_user_question）

审批卡的 `=1/=0/=c` 是工具审批专用三选一；`ask_user_question`（需要选择）的选项由调用方自定义，原微信侧未接故回复无效。v2.0.0 新增：

1. 订阅 `user-questions/request` waterfall（与审批对称，**回调返回的 `AskUserQuestionAnswer` 即回填**，不重复调 answer 服务）。
2. 微信侧交互卡即浮层超时后发出的**富格式卡**（不再另发即时短卡）：首行状态标签「需要选择」+ `/use <前缀>` + `绑定 <标题>` + 逐题正文 + `A/B/C` 选项，脚注写明 `<前缀> 1A 2B` 回填码（选项字母由 option 顺序生成）。
3. 微信回 `<前缀> 1A 2B`（多选如 `<前缀> 1AB`）后，按「题号 + 字母」映射到每题 option 的 **label 字符串**（`AskUserQuestionAnswerItem.selected` 要的是 label 而非序号），精确回填对应会话。
4. 多会话靠前缀区分、并行互不干扰；未绑定会话返回 `undefined` 交回 waterfall；`intent`（approval/plan-review）题跳过交回审批链路避免冲突；`questionTimeoutMs`（默认取 `approvalTimeoutMs`）到点回填空答案 fail-closed。

### 微信唯一可回填卡

用户要求：DSH 右下角浮层**即时**通知保持不变；微信侧**只要一套卡**，且这张卡是在浮层超时未处理后才触发，并且本身就是可回填的交互卡。据此调整：

- **停发 host 即时短卡**：`onApprovalRequest` / `onUserQuestions` 不再即时下发 `[审批请求]` / `[需要选择]` 方括号短卡；待决注册（`registry.register` / `questionPending.set`）与回填链路（`resolveByPrefix` / `resolveQuestions`）全部保留，行为不变。微信侧交互卡统一由 client 半边在浮层超时后发出的富格式卡承担（触发时机不变：需选择/授予权限 60s、任务跑完 30s）。
- **富格式卡可直接照抄回填**：脚注按卡片类型拆开并把该会话**实际短前缀**填进去——「需要选择」写 `<前缀> 1A 2B`（多选 `<前缀> 1AB`），「授予权限 / 计划审阅」写 `<前缀>=1 批准 / =0 拒绝 / =c 取消`；选项编号从「选项1/2/3」改为可直接回填的 `A/B/C`。done（任务完成）卡脚注仍是纯提醒、无回填码。
- **回填窗口延长**：`approvalTimeoutMs` 默认从 120s 提到 300s（5 分钟），覆盖「浮层 60s 超时 → 富格式卡到微信 → 用户回填」整段，避免卡片刚到就到期。

### 延迟提醒通知

- **超时提醒卡**：审批等待期间每 `remindIntervalMs`（默认 60s）发一张微信提醒卡，最多 `maxReminders`（默认 3）次。
- **自动降级**：硬超时 `approvalTimeoutMs`（默认 120s）或提醒耗尽后，按 `permissionPreset` 结算：`ask`→取消、`allow-once`→批准一次、`reject`→拒绝。
- **定时汇总**：`summaryIntervalMs`（默认 0 关闭）>0 时按间隔汇总所有未决请求。
- 所有定时器 `unref`，不阻塞宿主退出；`settle` 幂等，超时后的迟到回复 no-op。

## 配置项（cordis.patch.yml / 设置页）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `prefixLength` | 6 | 会话短前缀长度 |
| `approvalTimeoutMs` | 300000 | 回填硬超时（毫秒，默认 5 分钟，覆盖浮层超时→卡片到微信→回填） |
| `questionTimeoutMs` | 0 | 选择题硬超时（毫秒，0=用 approvalTimeoutMs） |
| `remindIntervalMs` | 60000 | 提醒卡间隔（毫秒） |
| `maxReminders` | 3 | 最多提醒次数 |
| `permissionPreset` | `ask` | 超时降级策略：`ask` / `allow-once` / `reject` |
| `summaryIntervalMs` | 0 | 未决汇总间隔（0=关闭） |
| `sessionEventMentions` | true | 会话事件镜像是否带前缀提及 |

微信登录状态持久化在 `~/.dsh-plugin-wechat-session/ilink-state.json`（mode 0o600），token 失效（errcode=-14）时状态变为 `stale-token`，需重新扫码。

扫码二维码直接内嵌在设置页显示，无需跳转外链：iLink 返回的 `qrcode_img_content` 是二维码网页 URL（text/html）而非图片字节，Host 侧 `qr.png` 路由用内置纯 JS 二维码库 `vendor/qrcode.cjs`（MIT，零 npm 运行时依赖）把 URL 编码成 GIF（`image/gif`）直接返回给设置页 `<img>`。登录状态以中文显示（未登录 / 等待扫码 / 已就绪 / 已过期 / 已超时 / 登录已失效）。

### 会话列表微信图标

去 dsh-im 后会话列表标题「微信 · 甜屿林风」退回纯文字。根因：图标只是 dsh-im 客户端的纯 DOM 视觉增强（`session-channel-logos.js`，MIT）——MutationObserver 监听列表行，用 CSS 伪元素把前缀替换成 SVG 图标，标题文本本身始终是持久化的纯文本。本插件在 client 半边移植了精简版（只微信、保留 MIT 版权声明、零 npm 依赖）：特性检测不满足时保底 noop，预载 Image 成功后接管图标渲染。只加图标、不改标题文本、不建会话、不重新引入 dsh-im。

真机首版曾未生效：验证用的 fakeDocument 无 DOM，图标逻辑一路 noop，断言全过却没覆盖真实渲染。补真 DOM mock 测试后定位并修复三处缺陷：① `[].slice.call(Set)` 无效使排队的 `update()` 从未运行（元凶，改 `Array.from`）；② observer 漏遍历 `record.addedNodes`，React 增量渲染的会话行未被处理；③ 特性检测把较新的 `attr() / ""` 语法当硬门槛，不支持即整段 noop（降为基础 `attr()`，`attr()/""` 作为可选增强）。现覆盖 childList 增量渲染 + 降级 CSS + dispose 还原。

## 移除项

- 运行时依赖 `@xmanrui/dsh-im`（顶层 `dependencies` 清空）。
- cordis.patch.yml 第二条 loader（`dsh-plugin-wechat-session-dsh-im`）及其防重挂载守卫。
- Bot ID / 目标 ID 配置与服务端兜底，改扫码登录。
- 独立「多会话 · 实时推送」开关、`testRealtime` 测试函数（保留历史配置字段以兼容旧配置）。

## 验证

- `node --check`：四模块全部通过。
- `node smoke/smoke-test.mjs`：**81 项断言全部通过**——清单契约、bridge 单测（前缀寻址 + `session-` 公共开头碰撞回归/幂等 settle/降级/提醒上限、`/use <前缀>` 反查绑定 + 失败回退字面、绑定状态持久化启动恢复 + bind/release 写回 + 幽灵目标防护、选择题解析/字母→label 回填/多选/intent 跳过/停发即时短卡仍保留待决注册）、富格式卡七段两行 + A/B/C 选项 + 按类型回填脚注逐字、7 条 Host 路由 + 官方 seam（含 user-questions/request）、扫码登录全流程、多会话并行审批、对话入站 + cordis 严格 inject 回归、出站流式聚合（仅 committed/assistant/message 投递 + assistant/attempt/abandoned/无 outcome 跳过 + session/event assistant/* 跳过）、按标题绑定四分支 + 端到端反查、iLink 端到端投递、会话列表微信图标（前缀解析 + 特性检测 noop + 真 DOM mock 增量渲染 + MIT 声明）、富格式卡七段两行绑定模板逐字、client half 回归。

### 会话短前缀算法

短前缀用于在微信里精确寻址会话（`91b217=1` 批准、`/list` 查看），也出现在所有审批卡与回显文本中。为避开真实会话 ID 普遍以 `session-` 开头导致的全量碰撞，`sessionPrefix()` 会跳过 `session-` 公共开头后取 6 位：`session-91b2175-db79-…` → `91b217`、`session-4bf2c3c3-e3f3-…` → `4bf2c3`；非 `session-` 开头的 ID（如 `3f2a-9bcc-11dd` → `3f2a9b`）和短 ID 保持原样。长度由 `prefixLength` 配置。

## 已知取舍

- 牺牲了「自动绑定」的便利：每次必须显式 `/use` 指定要操控的会话，换来零串话风险与彻底解耦。
- iLink 官方仅支持 direct chat（群聊不在支持范围）。
- token 寿命有限（社区实测约 24h），失效后需重新扫码。
