# v2.1.0 发布说明 — /new 薄创建会话 + 工作目录可配

> 功能新增（minor）。本版本按用户明确指定递增至 2.1.0。完整架构背景见 [v2.0.0 发布说明](RELEASE_NOTES_v2.0.0.md)。

## 一句话

在 v2.0.0「通道外设」基础上新增微信侧 `/new` 薄创建会话：可在设置页指定的工作区目录下新建会话并立即绑定，接着就能对话。插件仍不接管会话生命周期。

## 新增能力

### `/new` 薄创建会话

- 微信发 `/new` 或 `/new <标题>`：
  1. 把设置页指定的工作目录经 `ctx.workspaceController.create({ path })` 注册/幂等解析成工作区，拿 `workspaceId`；
  2. 用官方 `ctx.sessionController.create({ workspaceId })` 新建会话——**确保进入对应工作区分组**。`cwd` 与 `workspaceId` 互斥，仅传 `cwd` 的会话不属于任何 workspace、会落「未分组」（真机反馈 + asar 契约）；无 workspaceController 时才退回 `cwd`；
  3. 用 create 返回的真实 sessionId 先 `ctx.sessionController.resume({ sessionId })` 再 `ctx.sessionController.rename({ sessionId, title })` 命名（rename 契约要求「先显式 resume」）；标题一律加「微信 · 」前缀——省略标题为「微信 · Clawbot」，自定义如 `/new 甜屿林风1` → 「微信 · 甜屿林风1」，已带前缀不重复加；
  4. 自动 `/use` 绑定新会话，微信回「已新建会话「…」（前缀 …）并绑定。现在可直接发消息开始对话。」；
  5. 之后普通文本即投进该会话，agent 最终回复镜像回微信（与既有对话链路一致）。
- **薄创建边界**：只调一次 create + resume + rename 拿 sessionId 立即当绑定目标，**不维护会话池、不自动清理、不做映射表**，会话生命周期权威仍在 DSH。create/rename/resume 与 prompt 同为 `@Remote` 方法，均走 `ctx.get` 软获取（cordis 严格 inject 安全）。
- 「微信 · 」前缀标题仍可能被 DSH 在首条 prompt 后用 LLM 自动生成的标题覆盖（rename 无 pinned 字段）；之后重命名由 DSH 负责，用户已接受此边界。

### 工作目录可配并持久化

- 设置页新增「新建会话（微信 /new）」卡，**输入即自动** POST 到宿主 `/settings` 路由（第 8 条 HTTP 路由）并写 localStorage（真机发现旧「点保存才写」导致 `settings.json` 为空、`/new` 拿不到目录而落未分组）；底部保留保存按钮兜底。
- 宿主用零依赖 `lib/host/settings-store.js` 持久化到 `~/.dsh-plugin-wechat-session/settings.json`（mode 0o600、坏文件静默降级为空）；设置页挂载时 GET `/settings` 回读权威值。
- `cfg.settingsFile` 可覆盖路径（测试用）。

### 任意会话的审批/选择题都能在微信回填（真机修复）

- **问题**：富格式卡由 client 半边对**所有会话**发（浮层超时即推微信），但 host 的 `approval/request` / `user-questions/request` 应答者此前只服务已 `/use` 绑定的会话；未绑定会话（如刚 `/new` 出来的）收到的卡，微信回 `前缀=1` 或 `前缀 1A 2B` 时前缀不被识别，掉进自由对话分支误投给当前绑定会话（真机：91b21f 的选择卡回填跑到了「甜屿林风1」）。
- **asar 实证**：`ctx.approval` 无「按 callId 事后回填」接口，审批决策只能由 waterfall 应答者在请求当场返回；原生 UI 也是「注册应答者 + await 点击」。因此只能走官方 waterfall 竞答。
- **修复**：
  1. 两个应答者去掉「仅绑定会话」过滤——任意会话都注册待决，前缀反查范围从「绑定集合」扩大到「待决池」（`resolvableSessions()` 合并绑定 + 审批 pending + 选择题 pending）；
  2. 绑定会话保持「微信独占」（不调 `next()`，不回归「微信只要一套卡」）；未绑定会话传 `next()` 与原生 UI 应答器**竞答**——`Promise.race`，谁先 settle 谁定案，另一方幂等撤销待决；
  3. 微信回填走既有 `registry.resolveByPrefix` / `resolveQuestions`，精确命中待决会话。
- **边界**：竞答语义下先答者定案，另一方卡片可能残留（DSH waterfall 是链式 veto，插件无法无感同步状态）；这是 DSH 机制决定，已真机验证核心回填路径。`lib/index.js` 订阅两个 seam 时把 `next` 传进应答器。

### 全量文案同步

README.md / README.en.md / 设置页 i18n（loginHint / sectionHintShort / sectionHint / aboutFeatureText / newSessionCwdHint）/ package.json description / cordis.patch.yml 全部补上 `/new`、工作区分组与 v2.1.0 说明，设置页「关于」版本号改为 2.1.0。

### 错误提示中文化（真机修复）

真机发现底层 DSH 的英文错误（如 `session "..." not found`）被原样转发到微信、用户看不懂。新增零依赖 `humanizeError()`（lib/host/bridge.js）：把 `not found` / `without inject` / `timeout` / `unavailable` / `permission denied` / `invalid json` 等常见英文错误转成中文（如 `session "..." not found` → 「找不到该会话（可能已被删除或 ID 不对）」），已含中文或未知英文的错误原样保留。接入所有发往微信的错误分支：新建会话失败、按标题解析失败、会话未接受消息、转交失败、列举会话失败、工作目录注册失败、创建会话失败。

### 正文镜像改用可读标题抬头（真机修复）

真机反馈 agent 回复前的 `[短码]`（如 `[2f7b63]`）用户看不懂。正文镜像（onAssistantStream 最终回复 + onSessionEvent 非 assistant 事件）改为以 `DeepSeek Harness · 会话「标题」` 抬头再跟正文，标题走 `sessionQuery.readTitle` 软获取（ctx.get 严格 inject 安全），读不到时退回短码。审批/选择题回填卡、错误、提醒仍用 `[短码]` 作回填码（回填必需），不受影响。

### 归档会话发消息静默入队（真机修复）

真机反馈绑定的会话归档后，微信发消息仍「正常发出」却无人处理。asar 实证宿主 `sessionController.prompt` 入口不检查归档（归档闸门在 `agent/pre-step`，不在 prompt 入口），归档会话本体仍在持久化中，prompt 会把消息静默入队。`submitPrompt` 在投递前先用 `ctx.get('workspaceRegistry').archivedSessionIds` 检查（Set / 数组都兼容，软获取降级），命中则明确回「该会话已归档或已删除，无法发送消息。请用 /use 绑定其它会话， /new 创建新会话。」（同时引导 `/use` 绑定其它会话与 `/new` 新建），不再静默入队；真删除的会话 prompt 抛 `session "..." not found` 仍由既有 `humanizeError()` 中文化提示。

### 归档/删除会话误弹「对话完成」提醒（真机修复）

真机反馈归档或删除一个会话时，也会弹「对话完成」浮层并推微信富格式卡（各 2 次）。根因是归档/删除会同时引发 `running` 边沿与 `completionUnread` 上升沿，`noteAlert()` 只看 sessionStatus 无从分辨会话已失效。修复在 `noteAlert()` 唯一入口（一处覆盖弹窗 + 提示音 + 30 秒微信批次）加 `isArchivedOrDeletedSession()`（lib/client.js）：用 `ctx.get` 软获取 `workspaces` / `sessions`，归档判据取 `workspaces.list.getSnapshot().archivedSessionIds`，删除判据取 `sessions.list.getSnapshot().ids`（对齐宿主 dsh-client-ui-schedule 的 sessionLinkState；**不能用 byId**——它保留 local fallback 行）；两个信号只在「明确证明」归档/删除时静默，未就绪或空列表时保持原行为，避免启动竞态误伤正常完成通知。

## 配置表（新增/变更）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `newSessionTitle` | `微信 · Clawbot` | `/new` 省略标题时的固定命名（cordis.patch.yml config） |
| 工作目录 | 空（DSH 默认） | 设置页「新建会话」卡填写，持久化到 `settings.json`，不在 patch 配置里 |

其余配置键与默认值沿用 v2.0.0（`approvalTimeoutMs` 已为 300000）。

## 验证

`node --check` 五模块通过；`node smoke/smoke-test.mjs` → **89 项断言全部通过**，其中 v2.1.0 新增：

- `/new` 与 `/new <标题>` 的 parseInbound 解析；
- 薄创建 bridge 单测：默认标题兜底 + 自定义标题透传 + 立即绑定 + 回执 + 无 createSession 解析器时优雅降级；
- settings-store 单测：工作目录读写 + 坏文件降级；
- `/new` 端到端：工作目录 → `workspaceId` 进分组（断言 create 收到 workspaceId 而非 cwd）+ 标题加「微信 · 」前缀 + resume→rename 顺序 + 立即绑定；
- Host 路由数 7 → 8（新增 `/settings`），health 版本 2.1.0；
- 任意会话回填回归：未绑定会话的选择题 `前缀 1A 2B` 精确回填、未绑定会话审批与原生 UI 竞答（UI 先答透传）、未绑定会话审批卡可被微信 `前缀=1` 回填（m04261）。
- 错误中文化回归：`humanizeError()` 对 `not found` / `without inject` / `timeout` 等英文错误转中文、已含中文的原样保留。
- 正文镜像标题行回归：最终回复以 `DeepSeek Harness · 会话「标题」` 抬头、不再含 `[短码]`、跳过思考/中间播报（沿用既有回归）。
- 归档会话拦截回归：`workspaceRegistry.archivedSessionIds` 命中时 prompt 不投递、微信回「该会话已归档或已删除」明确提示（m04835）。
- 归档/删除会话误弹提醒静默回归：`archivedSessionIds` 命中、或不在 `sessions.list.ids`（byId 仍留 fallback 行）的会话，approval + done 均不弹窗 / 不起批次 / 不发微信，普通会话不误伤（m04769）。

历史回归（并行审批、选择题回填、富格式卡 A/B/C 脚注、绑定持久化、思考过程不逐条发、微信图标、iLink 端到端、client half）全部保持绿。

## 取舍与边界

- `/new` 是薄创建而非「拥有会话」：不建池、不清理、不映射，创建后即交还给 DSH 管理。
- 官方 iLink 仅 direct chat；token 有寿命，失效重扫；iLink 无头像接口，微信头像框由客户端按账号渲染，插件无法控制。
- 历史版本变更记录见 [CHANGELOG](../CHANGELOG.md)。
