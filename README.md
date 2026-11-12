# dsh-plugin-wechat-session（微信会话互通 · 聚合包）

给 **DeepSeek Harness 桌面端**用的提醒插件。核心功能：

> 会话里出现「需要你手动选择」「需要你确认权限」「模型这一轮回复结束」时，做**桌面提醒（提示音 / 系统通知栏）**；如果超过设定的时间还没切过去看 / 没把待办处理掉，就通过 **dsh-im 的微信机器人（普通微信）**把提醒发到你指定的那一个微信对话。两类事件各有独立超时：「需选择 / 确认」默认 **60 秒**、「任务跑完」默认 **30 秒**；前者的微信是**带问题原文 + 编号选项的清单**，可直接在微信里回编号 / 批准（见第 3.1 节）。

> **多条会话并行也管用**：界面停在 A 会话时，B / C 会话需要确认、需要选择或跑完，都会照常提醒；只有你正盯着的那条保持安静。窗口整个切到后台时，所有会话都提醒。

**v1.5.0 三类都弹「带具体内容」的通知**：以前本插件弹的是空洞的「DSH 需要你操作」。现在**需要确认权限 / 需要手动选择 / 任务跑完**三类事件都会弹**一张**系统通知，格式对齐 dsh-pet 的卡片——标题是「会话名 · 事件标签」（正在申请权限 / 模型在等你回答 / 对话完成），正文是 `pendingInteraction` 里抽出来的**具体问题文本 / 工具名+原因**；抽不到具体内容时回退成一句中文说明，不再是空洞卡片。**点任意一张通知都能切到对应会话界面**（`uiWorkspace.openSession(sid)` + 窗口提前台，照抄 dsh-pet）。提示音和 30 秒微信兜底**全部保留**。按你的决策，本插件与 dsh-pet 各自弹一张，屏幕上会出现两张相近卡片。详见第 1、4 节。

**v1.4.0 起「点击通知跳到对应会话」已实现**：所有系统通知的 `onclick` 都走 `jumpToSession(sid)`，v1.5.0 继续沿用。

**v1.3.0 修复「3 条会话并行、界面停在一条时其他 2 条不通知也不发微信」的 bug**：旧版把「仅后台提醒」错误地做成了「整个窗口在前台就全部静音」，导致其他会话的事件被吞掉。现在提醒判据与「已响应」判据都改为**会话级**（参考 dsh-whale-widget / dsh-notify-me 的会话级提示）。详见第 1、4 节。

**v1.2.0 起本包升级为「聚合包」**：装这一个包，就同时带上「微信会话互通」和 `@xmanrui/dsh-im`（微信机器人），不用再分两次装。两个插件的代码仍各自独立，dsh-im 继续走 npm 官方源、可单独升级。详见第 8 节。

**v1.1.0 起微信通道已改为 dsh-im 主动投递，不再使用 Server 酱 / SendKey。** 微信推送走的是 DSH 里已经接入的微信机器人，不需要任何外部 Webhook 服务。

**v1.1.1 修复「测试微信推送」报 `Invalid target id` 的问题**：dsh-im 的「复制调用参数」是一整段 JSON（`{"botId":"...","targetId":"..."}`），以前必须手动拆成两个纯 ID 分别填；现在**把整段直接粘到任意一个输入框里，会自动拆成两个纯 ID**，已存的旧配置也会自动清洗。报错也翻成了中文原因。

---

## 1. 它会在什么时候提醒

| 触发事件 | 判定来源 |
| --- | --- |
| 需要确认权限 | `uiSession.sessionStatus` 里 `pendingInteraction` 新出现（`approval` / `plan-review`） |
| 需要手动选择 | `uiSession.sessionStatus` 里 `pendingInteraction` 新出现（`question`） |
| 任务跑完 | `running` 由 true 变 false 且无待处理交互，或 `completionUnread` 出现上升沿（模型这一轮回复结束） |

数据源 `uiSession.sessionStatus` 是 `Map<sessionId, {...}>`，**天然覆盖全部会话**，不是只有当前打开的那条。当前正看着哪条，由 `sessions.list` 快照推导（老宿主读 `current`，0.1.6+ / 0.2.x 读 `retainedBy.mainView > 0` 的行）。

已确认的规则（按你的选择）：

- **会话级「仅后台 / 离开时提醒」**（v1.3.0 修正）：
  - 窗口整个切到后台 / 人离开桌面：所有会话都算「没在看」，三类事件一律提醒。
  - 窗口在前台（含 3 条会话并行、界面停在 A）：**只有「不是当前正看着的那条」才提醒**；A 自己保持安静——不弹通知、不响提示音、不启动兜底计时、也不补发微信。
  - 这就是旧规则「正看着窗口时一律不提醒」的正确解读：它指的是「正看着的那条会话」，不是「整个窗口」。
- **v1.5.0 三类事件都弹一张「带具体内容」的系统通知**（格式与 dsh-pet 一致）：
  - 标题统一为「会话名 · 事件标签」：需要确认权限 =「正在申请权限」、需要手动选择 =「模型在等你回答」、任务跑完 =「对话完成」。
  - 正文显示从 `pendingInteraction` 抽出来的具体内容（问题文本 / 工具名 + 原因，最长 160 字）；确实抽不到时回退成一句中文说明，不再弹空洞的「DSH 需要你操作」。
  - **任意一张通知点一下都切到对应会话界面**（`uiWorkspace.openSession(sid)` + 窗口提前台，照抄 dsh-pet）。提示音照响、微信兜底照常（按各自类别的超时）。
  - 按你的决策，本插件与 dsh-pet 各自弹一张，屏幕上会出现两张相近卡片；本插件不动 dsh-pet。
- **「有响应」= 切到那条会话去看 / 把待办处理掉**（v1.3.0 修正，替代旧的「回到窗口 / 页面变可见」）：桌面提醒发出后，只要**切到对应会话**或**把那条 `pendingInteraction` 处理掉**，就视为已响应，取消该条的微信补发。人本来就在窗口前时，「回到窗口」永远不会触发，所以旧判据会失效——这正是之前「也没有微信通知」的原因。
- **两类事件各有兜底超时，按各自 deadline 分批发微信**：桌面提醒发出后开一个批次，每条带自己的截止时间（「需选择 / 确认」用独立的 60 秒、「任务跑完」用 30 秒），计时器对准批次里**最早**那条；到点只把**已到期且仍未响应**的条目汇总成一条微信，未到期的留在批次里等下一次。前台也照发（只要没切过去看 / 没处理）。
- **发到你指定的那一个微信目标**：永远发到设置页里填的 `Bot ID + 目标 ID` 对应的那一个微信对话，不按会话来源推断、也不群发。

会话名会带进三类系统通知的标题和微信汇总里（取 `sessions.list` 行的 `displayTitle` / `title`，取不到再退回会话 id），这样能看出「哪条会话需要看 / 哪条跑完」。

---

## 2. 准备工作：拿到 dsh-im 的「Bot ID + 目标 ID」

微信推送依赖 `@xmanrui/dsh-im`（5.10.0，已启用，v1.2.0 起随本聚合包一起装上），用它已经接入的**普通微信机器人**做主动投递。

1. 在 DSH 里打开 **设置 → IM机器人**，确认你的微信机器人已接入并在线。
2. 点微信机器人卡片上的**齿轮**，复制 **Bot ID**（一串不透明字符串，形如 `bot_9577c8572d454122a4ef7fb4d8420a91`）。
3. 给这个机器人**新建目标**（从已聊过的会话里选，或手动填微信用户 ID `toUserId`），保存并「测试」能发通。
4. 点 **「复制调用参数」**，得到类似：
   ```json
   { "botId": "bot_9577c8572d454122a4ef7fb4d8420a91", "targetId": "tgt_a1b2c3d4e5f60718" }
   ```
5. 把这两个值填到本插件的设置页（第 3 节）。

> **最省事的填法**：直接把第 4 步复制到的**整段 JSON** 粘到设置页的「Bot ID」或「微信目标 ID」任意一栏，插件会自动拆成两个纯 ID 存好。不必手动裁切、也不必分别复制。以前若已把整段粘进去过，重开后会自动清洗成纯 ID。

> 微信渠道的主动投递复用「该机器人最近收到的对应用户 `context_token`」。升级 / 重启后若一直发不通（`ret=-2 prepare failed`），让目标用户给机器人发一条消息重建缓存即可，不需要反复重试心跳。

---

## 3. 安装与配置

### 安装（已装过可跳过）

命令行（桌面版 profile 一般是 `desktop`）：

```bash
dsh plugin --profile desktop add "file:F:/DeepSeek Harness workspace/default-workspace/dsh-plugin-wechat-session"
```

或用桌面应用内的「插件管理」填本地目录路径。**装完必须重开 DSH / 刷新页面**——浏览器半边是在页面加载时注入的。

> v1.2.0 起这个包是聚合包，装它会自动带上 dsh-im，不必再单独 `add @xmanrui/dsh-im`。本机已通过 `plugin_manager` 装好并写入 `profiles/desktop/package.json`。切换后的 profile 结构见第 8 节。

### 配置

重开 DSH 后，打开 **设置 → 微信会话互通**：

| 字段 | 说明 |
| --- | --- |
| 启用本插件 | 总开关。关掉后不弹通知、不响提示音、不发微信 |
| 微信机器人 Bot ID | 第 2 步复制的 Bot ID（纯 ID，如 `wx_xxx`）；也可把整段「复制调用参数」粘到这里 |
| 微信目标 ID | 第 2 步复制的 targetId（纯 ID，如 `tgt_xxx`）；整段 JSON 粘进来会自动拆成两个 ID |
| 任务跑完类超时（秒） | 默认 30，可填 5–3600；「任务跑完」这类事件超过这个秒数没切过去看就发微信 |
| 需选择 / 确认类超时（秒） | 默认 60，可填 5–3600；「需要手动选择 / 确认权限 / 指导进入下一步」这类待拍板事件单独一个超时，超时把**问题原文 + 编号选项**列成一张清单发微信，让你直接在微信里回复选择（见第 3.1 节） |
| 提示音 / 音量 | 三类事件都播放一段合成提示音，并各自弹一张带具体内容的系统通知 |
| 超时发微信 | 关掉后只做桌面提醒，不补发微信 |

两个 ID 都留空时，只弹桌面通知，不发微信；也可以把它们写进 `cordis.patch.yml` 的 `config.botId` / `config.targetId` 作为服务端兜底（注意该文件随 profile 落盘、对本机用户可读）。

设置页有两个按钮：**测试桌面通知**（弹一张「会话名 · 对话完成」的卡，点它可跳到对应会话）、**测试微信推送**，用来确认权限与投递链路。

浏览器控制台里还有调试 API：

```js
window.__dshPluginWechatSession.config       // 当前配置
window.__dshPluginWechatSession.testDesktop() // 手动弹一次「会话名 · 对话完成」桌面提醒（可点它跳会话）
window.__dshPluginWechatSession.testWechat()  // 手动发一条测试微信
window.__dshPluginWechatSession.debug()       // { bound, source, away, currentSid, sessionsBound, batch }
```

`debug().currentSid` 是插件推导出的「当前正看着哪条会话」，`sessionsBound` 表示 `sessions.list` 是否已订阅——排查多会话提醒时用得上；`notifyPermission` / `audioState` 用来排查「为什么没弹窗 / 没响」（v1.6.0）。

### 3.1 在微信里直接选择 / 批准（借 dsh-im 双向同步回填）

v1.6.0 起，「需要手动选择 / 确认权限 / 指导进入下一步」这类**待拍板**事件有独立超时（默认 60 秒，见配置表）。超时前没切进会话处理，微信里收到的不再只是「任务跑完了·xxx」一行，而是**像一张清单**的一条消息：

- **【等你拍板】段**：逐条列出「会话「XXX」 · 需要手动选择」、问题原文、`1) 2) 3)` 编号选项（含描述）、多选提示（用逗号分隔编号），以及「微信回『编号 / 选项文字 / 批准 / 拒绝』即可」的回复格式；
- **【已完成】段**：逐条写「会话「XXX」已完成（时间）」，一眼看出是哪个会话跑完了；
- 末尾附 dsh-im 双向同步配置指引。

**「在微信里直接选完自动回填 DSH」由 dsh-im 完成，不是本插件自己解析微信回复。** dsh-im 自带「交互式提问」（回复选项序号 / 选项文字 / 自定义文字，多选逗号分隔）与「远程审批」（批准 / 拒绝 / 同意 / 不同意 / yes / no），并且支持微信。要让这条链路真正生效，需要满足：

1. 该会话在 dsh-im 里**绑定一个已开启「双向同步」的微信私聊**——同步提问 / 审批只在私聊里提出，Web 或其他 Host 任务发起时要求「该会话恰好绑定一个这样的私聊」；
2. 本插件设置页填的 **Bot ID / 目标 ID 必须指向同一个微信对话**（否则清单发到 A、dsh-im 的回填在 B，对不上）；
3. dsh-im 是**一出现待办就即时推**到那个私聊，本插件这条清单是**超时留底**（60 秒没处理才发）。两者互补：即时那条能直接在微信里回编号 / 批准并回填；超时清单让你离开后仍能看清所有待拍板点、照着编号回。

> 说明：本插件通过 `ctx.dshIm.send()` 发出的微信，dsh-im **不会**替它解析回复（其入站订阅 `consumeInbound` 目前只对明确选择外部消费模式的飞书 / Lark 账号开放，微信不在其中）。所以「真回填」特指 dsh-im 自带的同步提问 / 审批这条链路；本插件负责把问题与选项写清楚，并提示你把它配到同一个私聊。不想配双向同步时，清单里的编号与「批准 / 拒绝」措辞仍可作为「回 DSH 里点哪一项」的备忘。

---

## 4. 实现结构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js`（Host half） | 注册 `/__dsh-plugin-wechat-session/wechat`（POST）与 `/health`（GET）两条同源回环路由；校验准入后调用 `ctx.dshIm.send(botId, targetId, text, { signal })` |
| `lib/client.js`（Client half） | 订阅 `uiSession.sessionStatus` 做**全部会话**的三类边沿检测；订阅 `sessions.list` 推当前会话；会话级静音 + WebAudio 提示音 + **三类都弹带具体内容、点击跳会话的系统通知**（标题「会话名 · 事件标签」）；每条按类别带独立 deadline 的会话级批次计时（默认 60 / 30 秒）；`describeInteraction()` 抽问题原文 + 编号选项；设置页；超时把清单 POST 给 Host 路由 |
| `cordis.patch.yml` | **一次 insert 挂两条 loader 行**（本插件 + `@xmanrui/dsh-im`），后者带防重守卫；另含服务端兜底 `config.botId` / `config.targetId` |
| `package.json` | `dependencies` 声明可升级的 `@xmanrui/dsh-im`（装伞包自动带上）；`dsh.bundle.patch` / `dsh.client.inject` / `dsh.manifestVersion: 1` |
| `locale/en.json`、`locale/zh.json` | 展示元数据（en 为发现基线） |
| `icon.svg` | 36×36 双色渐变图标 |
| `smoke/smoke-test.mjs` | 纯 Node 冒烟测试（含多会话回归） |

### 会话级逻辑（v1.3.0，修复多会话静音）

- `shouldAlert(sid)`：`isAway()` 为真（窗口整个在后台）时永远提醒；否则 `sid !== currentSessionId()` 才提醒。旧版这里是 `if (!isAway()) return;` 的**窗口级一刀切**，正是 bug 根因。
- `currentSessionId()` / `sessionLabel(sid)`：照抄 dsh-notify-me `lib/client.js:2693-2705` 的推导（`snapshot.current` 或 `retainedBy.mainView > 0`），并从 `sessions.list` 行取显示名。
- `toast(title, body, isDone, sid)`：通知 `tag` 带会话 id，不同会话互不顶替；`onclick` 调 `jumpToSession(sid)` 切过去看。
- 批次每项记 `{kind,label,sid,dedupe,at,curAt}`，`curAt` 是「提醒发出时正看着哪条」，用来区分「后来切过去看」与「本来就是当前会话」。
- `itemResponded(it,cur,snap)`：切到该会话（`it.sid===cur && cur!==it.curAt`）或「非 done 且 `pendingInteraction` 消失 / 会话从快照消失」。`done` 类只认切过去看，避免把 `running→false` 的自然变化误判成已查看。
- `reapBatch(fromReturn)`：会话切换 / 状态变化时回收已响应条目；`fromReturn=true`（窗口从后台回前台）时，把「本来就是给当前会话弹的」提醒算已看到。
- `fireBatchTimeout()`：不再有 `isAway()` 闸门，超时点按最新 `currentSessionId()` + `uiSession` 快照再筛一次，只发仍未响应的条目（前台也照发）。

### 桌面通知 / 点击跳转（v1.5.0，三类都弹带具体内容）

- `textFromPayload(payload)`：照抄 `dsh-notify-me` `lib/client.js:2847-2885`，从 `pendingInteraction`（扁平字段 / `PendingApproval(toolName,reason)` / `PendingQuestion(questions[])`）里抽 `text/question/prompt/title/summary/description/message/operation/toolName/reason/name/tool` 与 `questions[0].question`，最长 160 字；`toolName` 带 `reason` 时拼成「工具名 · 原因」。
- `noteAlert(kind, label, sid, key, payload)`：**三类都调 `toast(...)`**，不再分叉成「只响提示音」：
  - 标题 = `sessionLabel(sid) + ' · ' + 事件标签`，事件标签取 `正在申请权限` / `模型在等你回答` / `对话完成`（与 dsh-pet 一致）。
  - 正文 = `textFromPayload(payload)`；抽不到具体内容时回退成「事件标签：点这条通知切到该会话查看具体内容；{n} 秒内没看会发微信。」
  - 第 4 参 `sid` 既作通知 `tag`（不同会话互不顶替）又作点击跳转目标；`playCue(isDone)` 由 `toast()` 内部统一播放。
- `jumpToSession(sid)` / `toast()` 的 `onclick`：照抄 `dsh-pet` `lib/client.js:3431-3448` 的 `wireNotificationClick` / `jumpToSession`——`lookupService('uiWorkspace').openSession(sid)` 切会话（旧版没该服务就跳过）、`window.focus()`、Electron 下用 `dsh://open` iframe 把窗口提到前台。
- `testDesktop()` 与 `window.__dshPluginWechatSession.testDesktop()` 弹「会话名 · 对话完成」这张卡，方便验证通知与点击跳转。

### 为什么微信要经 Host 中转

浏览器半边只负责「什么时候该提醒」和「桌面通知 / 提示音」；`dshIm` 主动投递服务只存在于 **Host** 侧（`ctx.dshIm`）。所以超时后浏览器把 `{title, desp, botId, targetId}` POST 给本插件自己的同源路由，由 Host 半边调用 `ctx.dshIm.send(...)` 发出去。这样也自动复用了 DSH 的 HTTP 准入裁决（`ctx.connection.requestRejection(req) === undefined` 才放行）。

`dshIm` 是**软依赖**：用 `ctx.inject(['dshIm'], ...)` 按需绑定，即使 dsh-im 暂时未就绪，本插件仍能挂载（此时发微信返回明确的 `502 dshim-unavailable`，桌面提醒不受影响）。

### 关键宿主契约（照抄已验证写法）

- 路由一律 `ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))`，返回值作为清理函数。
- 每条 HTTP 路由先过 `ctx.connection.requestRejection(req)`，仅 `undefined` 放行。
- 客户端经 `window.__ModuleLoader__.load({ id, factory })` 注入；`uiSession` 用 `ctx.get('uiSession')` 懒查（直接读 `ctx.uiSession` 会抛 `cannot get property "uiSession" without inject`）。
- 设置页走 `ctx.slots.inject('settings.section', ...)`，配置存 `localStorage`。
- 不声明 `engines.dsh`；不含 `cordis` 依赖；不含 `preinstall/install/postinstall/prepare` 脚本。

### dsh-im 主动投递契约（来自 `PROACTIVE_DELIVERY.md`）

```
ctx.dshIm.send(botId, targetId, text, { signal, format? }) -> { sent: true }
```

- `result.sent !== true` 一律视为失败。
- 只发非空文字；不保存投递历史、不自动重试、不生成幂等键。`{sent:true}` 只代表平台接口已接受，不承诺送达或已读。
- 微信长文本按 1800 字分段；本插件把汇总文本截到 1800 字以内，避免刷屏。
- 常见错误：`unknown-bot` / `unknown-target` / `bot-not-connected`（机器人离线）/ `delivery-failed` / `target-rejected` / `invalid-target`（`Invalid target id`，即把整段 JSON 当成纯目标 ID 传了，v1.1.1 起本插件会自动拆分）。
- v1.1.1 起，这些英文错误在「测试微信推送」里会显示为中文原因，不再是英文原文或一坨 JSON。

---

## 5. 取舍与已知边界

- **只提醒「插件加载后新发生」的事件**：插件加载那一刻已经挂着的待办 / 已完成状态属于陈旧状态，只建立基线、不补发提醒（seed 抑制）。
- **按类别双超时、会话级回收**：每条提醒带自己的 deadline（「需选择 / 确认」默认 60 秒、「任务跑完」默认 30 秒），同批里计时器对准最早那条；到点只发已到期且未响应的条目，未到期的留到下一次（最多 20 条）；切到对应会话 / 把待办点掉即从批次里移除，全响应则整批取消，不会刷屏。
- **桌面通知需要系统权限**：v1.6.0 起插件激活时即主动申请 `Notification.permission`（不再只等第一次点击 / 按键），每次提醒前还会重试；系统拒绝授权时弹窗不可用，但会去掉静音让**系统提示音兜底**、WebAudio 提示音仍在，并在控制台留中文日志（可用 `window.__dshPluginWechatSession.debug()` 看权限与音频状态）。Electron 44 的 renderer 通知不放操作按钮，所以本插件的桌面通知只做提醒，不在通知上做「同意 / 拒绝」。点任意一张通知都会切到对应会话；旧版宿主没有 `uiWorkspace.openSession` 时点击仍能 `window.focus()` 把窗口提前台，只是不会切换会话。
- **后台委托 / 子代理会话一律静默**（v1.6.0）：Mnemon「自进化」落盘的任务及子代理会话（`[dsh-mnemon:delegated skill]` 这类）不提醒、不弹窗、不发微信；判据见第 4 节 `isIgnoredSession(sid)` 与 `docs/RELEASE_NOTES_v1.6.0.md`。
- **微信机器人必须在线且目标有效**：机器人离线或目标 ID 不对时会返回错误，页面控制台会记一条 warn；桌面提醒仍然照常。
- **「当前会话」依赖 `sessions.list` 的 retention 信息**：`inject` 已声明 `sessions`；若某个宿主版本完全没有该服务或快照结构不同，`currentSessionId()` 会退回 `null`，此时前台下所有会话都会提醒（不会漏提醒，只是可能多提醒当前那条）。后台逻辑不受影响。

---

## 6. 改完代码如何让已安装的插件生效

`profiles/desktop/node_modules/dsh-plugin-wechat-session` 是安装时**复制**进去的目录（不是软链），所以直接改工作区源码不会自动同步。让改动生效有两种方式：

1. **重启 DSH**：Host half 由 profile 的 bundle 加载，重启会重新读盘。
2. **重新安装一次**（推荐，确保 profile 副本与源码一致）：
   ```bash
   dsh plugin --profile desktop remove dsh-plugin-wechat-session
   dsh plugin --profile desktop add "file:F:/DeepSeek Harness workspace/default-workspace/dsh-plugin-wechat-session"
   ```
   然后重开 DSH 刷新页面，client half 才会重新注入。

验证：`npm test` 跑冒烟测试；`GET /__dsh-plugin-wechat-session/health` 返回 `200` 且 `dshImReady: true`（从 DSH 页面里同源访问；命令行裸请求会被准入裁决挡成 403，属预期）。

---

## 7. 开发与自检

```bash
npm test          # 冒烟测试（纯 Node，无需 DSH 宿主）
npm run pack      # npm pack --dry-run，确认打包文件清单
```

---

## 8. 聚合包：一次装两个 + 怎么各自更新（v1.2.0）

这是按你「把 2 个插件打包成 1 个插件，同时两个插件都能随时拿到各自最新版」的要求做的形态。需要诚实说明里面的约束，别把它理解成「揉成一份代码」或「后台自动升级」。

### 8.1 「装 1 个包带上两个」是怎么做到的

- `package.json` 里声明 `dependencies: { "@xmanrui/dsh-im": "^5.10.0" }`（**可升级范围，不锁死精确版本**）。装本包时 pnpm 会把 dsh-im 一起装进 profile 的 `node_modules`。
- `cordis.patch.yml` 里**一个 `insert` 挂两条 loader 行**：
  1. `id: dsh-plugin-wechat-session / name: 'dsh-plugin-wechat-session'` —— 本插件自己；
  2. `id: dsh-plugin-wechat-session-dsh-im / name: '@xmanrui/dsh-im'` —— 微信机器人，带一条 `disabled: !!js` **防重复挂载守卫**（含 `e.options.id !== 'dsh-plugin-wechat-session-dsh-im'` 自排除，照抄 dsh-better-sidebar 已验证范式）。
- 宿主 client 半边是按每条 loader 行的 `options.name` 逐条扫描的：两条行会各自加载自己包里的 `./client`。所以「微信会话互通」设置页和 dsh-im 的「IM机器人」设置页**都在**，不会丢。
- 两个插件的代码仍然是各自独立的两份（本包 + dsh-im 的 npm 包），没有揉成一份，也没有把 dsh-im 那 29 MiB、带原生模块的源码物理复制进来——那样会变成固定快照，反而违背「随时最新」。

### 8.2 为什么 dsh-im 还得保留 profile 顶层直接依赖

DSH 的「检查更新」和 dsh-im 自带更新器**只认 profile 顶层 `dependencies` 里的直接 registry 依赖**；如果一个包只是伞包的传递依赖，就不会被当成独立可更新项。因此切换时：

- **保留** `profiles/desktop/package.json` 顶层的 `"@xmanrui/dsh-im": "^5.10.0"`（这是它能拿官方新版的前提）；
- **从 `dsh.profile.bundles` 里移除**原来那条独立的 `"@xmanrui/dsh-im"` 挂载行——否则它自带的 patch 会再挂一条同 `name` 的 entry，与聚合包这条重复，启动会报 `duplicate prefix route` / 同名包多来源。挂载权统一收归聚合包这一条。
- 第二条 entry 上的 `disabled: !!js` 守卫是安全网：万一有人又把独立 bundle 加了回来且排在前面，本行会自动退避，不会双挂。

> 聚合包这条 dsh-im entry 用独立 id `dsh-plugin-wechat-session-dsh-im`（不用 dsh-im 自带的 `xmanrui-dsh-im`），是为了让守卫里的「自排除」能区分自己和另一条同名挂载：若 id 相同，自排除会把需要退避的独立挂载也排掉，守卫就失效了。已核实 dsh-im 不按 loader entry id 索引机器人配置（走 settings / credential-store），换 id 不影响你已配好的微信机器人。

### 8.3 「我说一声就更新」——怎么做、边界在哪

按你选的「我说一声就更新」，**不做后台定时 / 启动自动检查**（DSH 本身也没有这种自动更新服务）。你要更新时告诉我一声，我显式跑一条依赖更新把两个插件都拉到各自最新，然后你重开 DSH 生效：

- **dsh-im**：作为顶层直接依赖，走 `pnpm update @xmanrui/dsh-im`（或经插件管理器的「检查更新」）拉 npm 官方最新版 —— 这是真正能拿到「官方新版」的那一个。
- **dsh-plugin-wechat-session**：它是 `file:` 本地源码、不是发布到 npm 的包，没有「官方发布的最新版本」可拉；它的「最新」就等于本工作区这份源码。我改完源码、同步进 profile 副本即可。
- 更新完**必须重开 DSH 桌面端**（清 ESM 缓存、让两个 client 半边重新注入）。

诚实边界：在「一个全新 profile、纯靠伞包安装、顶层没有 dsh-im 直接依赖」的场景里，dsh-im 会退化成传递依赖，失去市场/自带更新器的独立识别——这时只能整包重发 + 手动重解析依赖。本机通过保留顶层直接依赖规避了这一点。

---

## 9. 自动发布 / 双端同步 / 市场收录（v1.6.0）

本版把「重大更新自动发 npm」和「GitHub main 有更新自动同步到 Gitee」两条流水线补齐，
并把 npm 发布改成更安全的 **OIDC 可信发布**。

| 文件 | 触发 | 做什么 |
| --- | --- | --- |
| `.github/workflows/test.yml` | push / PR | Node 24 跑离线冒烟测试（actions @v7） |
| `.github/workflows/sync-gitee.yml` | `main` push / 手动 | 把 main 与全部标签经 SSH `--force --prune` 镜像到 Gitee |
| `.github/workflows/publish.yml` | `main` push / `v*` tag / 发 Release / 手动 | `npm test` → 幂等守卫 → `npm publish --provenance --access public`（OIDC，无 token） |

### 9.1 npm 可信发布（OIDC / provenance）

- Workflow 用 `permissions: contents: read, id-token: write`、**Node 24（Active LTS）**、
  `actions/checkout@v7` / `actions/setup-node@v7`（均为 node24 runtime）、
  `npm install -g npm@latest`（保证 npm ≥ 11.5.1），末步 `npm publish --provenance
  --access public`，**不设 `NODE_AUTH_TOKEN` / `NPM_TOKEN`**。
- 幂等守卫 `npm view "$NAME@$VERSION" version`：版本号没升的 push 自动跳过，
  不会因 npm 版本不可变报错；只有 registry 上不存在的新版本号才发版。
- **一次性前提（npmjs.com 网页，CI 代劳不了）**：为 `dsh-plugin-wechat-session` 配 Trusted
  Publisher —— Organization/user `sweet560`、Repository `dsh-plugin-wechat-session`、
  **Workflow filename 逐字填 `publish.yml`**、Environment name 留空；`package.json` 的
  `repository.url` 已与该 GitHub 仓库一致。没配时 CI 会鉴权失败、不会降级到 token 发布。
- **「先有鸡还是先有蛋」—— 首版发布**：npm 要求「包先存在」才能配置 Trusted Publisher，
  所以 OIDC 无法完成一个全新包名的第一次发布。本包（`dsh-plugin-wechat-session` 是改名后的
  全新名字）的 **1.6.0 首版由本机已登录的 npm 账号手动 `npm publish --access public` 建包**
  （不带 provenance）；建包后再完成上面的 Trusted Publisher 配置，**之后升了 version 的
  push / tag 才由本 workflow 用 OIDC 自动发布**。换句话说：OIDC 面向后续版本，不面向首版。

### 9.2 GitHub main → Gitee 自动同步

- 需要仓库 Secret `GITEE_SSH_PRIVATE_KEY`：**OpenSSH 私钥本体**
  （`-----BEGIN OPENSSH PRIVATE KEY-----` 开头），对应已加到 Gitee 账户的公钥。
- 安装步骤会校验私钥类型（`ssh-keygen -y -f`），公钥 / PPK / 带口令都会报错退出。
- 同步用 `git@gitee.com:wtt520wyl/dsh-plugin-wechat-session.git` 直推，附带
  `ssh-keyscan -t ed25519 gitee.com` 写 known_hosts。

### 9.3 DSH 插件市场收录

- GitHub 仓库 Topics 补齐为 10 个。
- 向 `awesome-dsh-plugin` 目录提交 `data/plugins/sweet560__dsh-plugin-wechat-session.yml`
  收录 PR；DSH 站内插件市场 `dshmarket` 会自动抓取该目录（通常一天内可见）。

---

当前版本：**1.6.0**（三类事件都弹一张带具体内容、对齐 dsh-pet 格式的系统通知，点任意通知切到对应会话；提示音与微信兜底全部保留；会话级提醒 / 会话级「已响应」；装 1 个包带上微信提醒 + dsh-im 微信机器人，dsh-im 走 npm 官方源可升级；微信通道 dsh-im 主动投递；v1.1.1 的整段 JSON 自动拆分与中文报错仍在）。

> **本机未发版改动（不算已发布的 1.6.0）**：微信通知升级为「按事件类别双超时」——「需选择 / 确认」默认 60 秒、「任务跑完」默认 30 秒，各自起算、到点分批发送；超时微信改成带问题原文 + 编号选项的清单（【等你拍板】/【已完成】两段，突出是哪个会话），可配合 dsh-im 双向同步在微信里直接回编号 / 批准（见第 3.1 节）。此项仅在本机生效，待确认效果后再决定是否升版本号发版。

**v1.6.0 更新要点**：① 忽略 Mnemon「自进化」落盘的后台子代理 / 委托技能会话（`[dsh-mnemon:delegated skill]` 这类），不弹窗、不响提示音、不发微信；② 治本修复「窗口切到后台时需要确认 / 选择的卡片不弹窗也不响」——启动即主动申请通知权限、每次提醒前重试解锁、去掉静音让系统提示音兜底、失败写日志、`debug()` 暴露权限与音频状态；③ CI 改为 **npm 可信发布（OIDC / provenance）** 与 **GitHub main → Gitee 自动同步**，补齐仓库 Topics 并提交 DSH 插件市场收录。详见第 9 节与 `docs/RELEASE_NOTES_v1.6.0.md`。
