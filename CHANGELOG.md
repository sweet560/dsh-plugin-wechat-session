# 更新日志

本文件记录 dsh-plugin-wechat-session（微信会话互通 · 聚合包）的版本更迭。
全部条目用中文书写。

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
