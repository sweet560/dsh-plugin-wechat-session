# dsh-plugin-wechat-session（微信会话互通 · 通道外设版 v2.1.0）

给 **DeepSeek Harness 桌面端**用的提醒 + 微信通道插件。**v2.0.0 是破坏性重构**：去掉 `@xmanrui/dsh-im` 聚合依赖，独立通过官方 iLink 协议收发微信，不接管会话生命周期，只做**通道适配器 + 会话引用者**；你用 `/use` 显式绑定的会话会作为对话投递目标并持久化，重启免重绑。**v2.1.0 新增 `/new` 薄创建会话**：可在微信里发 `/new` 在指定工作区目录新建会话并自动绑定（标题自动加「微信 · 」前缀，缺省为「微信 · Clawbot」）。

## 核心功能

- **桌面提醒**：会话出现「需要选择 / 确认权限 / 模型回复结束」时，弹一张应用内浮层卡（点一下跳到对应会话）+ 提示音；多会话并行时只提醒你「没在看」的那些。
- **超时微信兜底**：超过 60 秒（需选择/确认）或 30 秒（任务跑完）没处理，发一张富格式微信卡留底（带短前缀与标题）。
- **双向自由对话**：`/use` 绑定或直接 `/new` 新建后，微信里发的普通文本会投进该会话、agent 最终回复镜像回微信（中间思考过程不逐条播报）。正文镜像用可读标题行 `DeepSeek Harness · 会话「标题」` 抬头，不再是难懂的短码。
- **双向多会话并行审批**：在微信里 `/use <会话ID>` 显式绑定会话，审批卡带短前缀（如 `[3f2a]`），回 `3f2a=1` 批准 / `=0` 拒绝 / `=c` 取消，精确投递到那条会话——多会话审批彼此独立并行，不再受 1:1 串行限制。
- **延迟提醒**：审批等待期间定时发提醒卡，超时或提醒耗尽后按策略自动降级，可定时汇总未决请求。
- **失效会话不误投、不误报**：绑定的会话被归档/删除后，微信发消息会明确提示「已归档或已删除，请用 /use 绑定其它会话或 /new 新建」，不再静默入队；归档/删除会话也不再误弹「对话完成」浮层与微信卡。

完整重构说明见 [v2.0.0 发布说明](docs/RELEASE_NOTES_v2.0.0.md) 与 [CHANGELOG](CHANGELOG.md)。

## 1. 安装与登录

1. 照 DSH 插件常规方式安装本包（**单插件，不再需要 dsh-im 聚合包**）。
2. 打开插件设置页 →「微信通道 · 扫码登录」→ 点「扫码登录」→ 用微信扫二维码。
3. 扫码确认后自动保存凭据并启动收发；登录状态持久化在 `~/.dsh-plugin-wechat-session/ilink-state.json`（mode 0o600），token 失效（errcode=-14）时重新扫码即可。
4. （可选）在设置页「新建会话（微信 /new）」卡填工作目录——输入即自动保存，这是微信发 `/new` 时新建会话所在的工作文件夹（会话会进入该目录对应的**工作区分组**，不会落「未分组」），持久化在 `~/.dsh-plugin-wechat-session/settings.json`。

> 无需再填 Bot ID / 目标 ID。官方 iLink 仅支持 direct chat（私聊），不支持群聊；token 寿命有限（社区实测约 24h），失效需重扫。

## 2. 在微信里驱动会话（显式寻址）

会话靠你显式引用：用 `/use` 绑定已有会话（或 `/new` 新建一个并自动绑定），绑定会持久化、重启免重绑。所有操作靠显式会话引用；短前缀取 sessionId 去掉 `session-` 公共开头后的 6 位（如 `session-91b2175-…` → `91b217`），避免全撞成 `sessio`。

| 指令 | 作用 |
| --- | --- |
| `/new` 或 `/new <标题>` | 薄创建会话并立即绑定：在设置页指定工作目录对应的**工作区分组**新建，标题自动加「微信 · 」前缀（如 `/new 甜屿林风` → 「微信 · 甜屿林风」，省略标题为「微信 · Clawbot」）；之后可直接对话 |
| `/use <会话ID>` 或 `/use <前缀>` | 绑定已有会话（可绑多个，审批并行）；前缀如 `91b217` |
| `绑定 <会话标题>` 或 `/use <标题>` | 按标题短名绑定（如 `绑定 微信·甜屿林风`），无需记全 ID；唯一命中直接绑定，多命中回候选列表 |
| `/list` | 查看已绑定会话与前缀 |
| `/release` | 释放全部绑定 |
| `/help` 或 `/?` | 查看帮助 |
| `3f2a=1` / `3f2a=0` / `3f2a=c` | 批准 / 拒绝 / 取消该会话的审批（别名：`1/y/yes/允许/批准`、`0/n/no/拒绝`、`c/取消`） |
| `3f2a 1A 2B` | 回答该会话的选择题（ask_user_question），多选如 `3f2a 1AB`，按题号+字母映射选项 |

- 微信侧只有一套交互卡：DSH 右下角浮层**即时**提示保持不变；浮层超时未处理后，微信才收到一张富格式卡（任务完成 / 需要选择 / 授予权限），这张卡本身就是可回填的。
- 富格式卡含 `/use <前缀>` + `绑定 <会话标题>` 两行（按触发会话实际填入），可按任一方式绑定该会话。
- 需要选择卡：逐题正文 + `A/B/C` 选项，脚注写实际前缀回填码，如 `3f2a 1A 2B`（多选 `3f2a 1AB`），精确回填对应会话。
- 授予权限 / 计划审阅卡：脚注写实际前缀回填码，如 `3f2a=1 批准 / 3f2a=0 拒绝 / 3f2a=c 取消`。
- 回填窗口默认 5 分钟（`approvalTimeoutMs`），确保浮层超时后卡片到微信仍有充足时间回复。
- 回复未带前缀或前缀未知 → 提示明确指定，**不猜「最近一个」**，零串话风险。
- 正文镜像只对已显式绑定的会话投递，以 `DeepSeek Harness · 会话「标题」` 抬头（标题取自 DSH，读不到时退回短码）；审批/选择卡仍用 `[前缀]` 作回填码。未绑定会话不接收正文镜像或聊天指令，但其浮层超时后的富格式卡仍可用卡内前缀回填（与 DSH 原生 UI 竞答、先答者生效），不会误投给当前绑定会话。

## 3. 配置项

`cordis.patch.yml`（或设置页）可覆盖：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `prefixLength` | 6 | 会话短前缀长度 |
| `approvalTimeoutMs` | 300000 | 回填硬超时（毫秒，默认 5 分钟，覆盖浮层超时→富格式卡→回填） |
| `remindIntervalMs` | 60000 | 提醒卡间隔（毫秒） |
| `maxReminders` | 3 | 最多提醒次数 |
| `permissionPreset` | `ask` | 超时降级：`ask`（取消）/ `allow-once`（批准一次）/ `reject`（拒绝） |
| `summaryIntervalMs` | 0 | 未决汇总间隔（0=关闭） |
| `questionTimeoutMs` | 0 | 选择题回填超时（0=沿用 approvalTimeoutMs） |
| `newSessionTitle` | `微信 · Clawbot` | `/new` 省略标题时的固定命名 |

工作目录不在 patch 配置里，而在设置页「新建会话（微信 /new）」卡填写（输入即自动保存），持久化到 `settings.json`；`/new` 会把它注册为工作区并让新会话进入对应分组。

## 4. 实现结构

```
lib/
  channel/
    ilink.mjs       纯 iLink 协议客户端（移植 gtaifu/dsh-wechat-bridge，对照官方 SDK 2.4.6，零依赖）
    transport.js    纯 iLink 适配器（扫码/收消息/typing/发文本），不 import 任何 DSH 包
  host/
    bridge.js         SessionEventBridge + ApprovalGate + 指令解析（只接收注入的 send/log，无 DSH import）
    binding-store.js  绑定状态持久化（sessions + activeSession）
    settings-store.js /new 工作目录持久化（newSessionCwd）
  index.js            宿主 apply：注册 8 条 HTTP 路由 + ctx.on('session/event') / ctx.on('approval/request') seam
  client.js           设置页扫码登录 + 工作目录配置 UI + 应用内浮层/提示音（只读镜像呈现）
```

审批/选择题决策的所有权始终在 DSH 的 `approval/request` / `user-questions/request` waterfall 上：插件注册为应答者，回调里 await 微信回复再返回决策。回填前缀不仅查已绑定会话，还查**待决池**——所以任意会话（含刚 `/new` 出来、未 `/use` 绑定的）的富格式卡都能用卡内前缀回填，不会误投给当前绑定会话。绑定会话由微信独占应答（不调 `next()`，符合「微信只要一套卡」）；未绑定会话则传 `next()` 与 DSH 原生 UI 应答器竞答（`Promise.race`，谁先答谁定案、另一方幂等撤销）。竞答下先答者定案，另一方卡片可能残留——这是 DSH waterfall 链式 veto 机制决定的边界。

## 5. 开发与自检

```bash
node --check lib/index.js lib/host/bridge.js lib/host/binding-store.js lib/host/settings-store.js lib/channel/transport.js lib/channel/ilink.mjs
node smoke/smoke-test.mjs   # 89 项断言：清单契约 + bridge 单测 + /new 薄创建(workspaceId 进分组 + 前缀命名) + settings-store + 错误中文化 + 8 路由/seam + 扫码登录 + 并行审批 + 任意会话回填 + 正文标题行 + 归档/删除会话拦截 + iLink 端到端 + client 回归
```

改完代码后重新打包安装、重启宿主即可生效（用户已授权 agent 直接安装验证包）。

## 6. 取舍与边界

- 不自动建立/跟随绑定：首次须显式 `/use` 指定（或 `/new` 新建），之后持久化、重启免重绑，换来零串话风险与彻底解耦。
- `/new` 是「薄创建」：只调一次 DSH 官方 create（带 workspaceId）+ resume + rename 拿 sessionId 立即绑定，不维护会话池、不自动清理、不做映射表；会话生命周期权威仍在 DSH。`cwd` 与 `workspaceId` 互斥，仅传 cwd 会落「未分组」，故先把工作目录注册为工作区再建会话。
- 「微信 · 」前缀标题可能被 DSH 首条 prompt 后的自动标题覆盖（rename 无 pinned 字段），之后重命名由 DSH 负责。
- 官方 iLink 仅 direct chat；token 有寿命，失效重扫；iLink 协议无头像接口，微聊头像框由微信客户端按账号渲染，本插件无法控制。
- 历史版本（v1.x，dsh-im 聚合包）的变更记录见 [CHANGELOG](CHANGELOG.md)。
