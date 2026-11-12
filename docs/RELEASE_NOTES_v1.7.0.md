# v1.7.0 发布说明（微信会话互通 · 唯一弹窗 + 卡片式设置页 + 极简微信）

发版日期：2026-11-12
npm 包：`dsh-plugin-wechat-session@1.7.0`
仓库：GitHub `sweet560/dsh-plugin-wechat-session` / Gitee `wtt520wyl/dsh-plugin-wechat-session`

---

## 这个版本做了什么

v1.7.0 把桌面提醒形态、设置页排版与微信内容做了一次集中整理，全部来自本机实测反馈：

- 之前每次提醒会**同时弹两个窗**（应用内浮层卡片 + 系统通知横幅），用户反馈太复杂；
- 设置页是一大段说明 + 平铺黑白输入框，用户反馈太丑；
- 超时微信是一堵「问题原文 + 编号选项 + 回复格式 + 绑定长文」的文字墙，看得很乱；
- 在微信里回「1」被 dsh-im 机器人当成聊天消息，没有回填到 DSH 的选择卡片。

**会话级提醒 /「已响应」判定 / 提示音 / dsh-im 微信通道 / 三级配置迁移全部保留不变。**

### 1. 只留「唯一一张应用内浮层卡片」

- `toast()` 删掉整段 `new Notification(...)` 分支，现在只做
  `ensurePermission()` → `showInAppToast()` → `playCue()`。浮层是屏幕上**唯一**的弹窗，
  系统通知横幅不再弹，也不会再出现「两个弹窗」。
- 浮层固定在窗口**右下角**（`right / bottom: 16px`），挂在 `document.body` 上、
  `zIndex: 2147483647`、`maxWidth: 360px`，**不依赖系统通知权限**：即使
  `Notification.permission` 被拒绝、或人停在别的会话界面，也一定看得到。
- 卡片带标题「会话名 · 事件标签」与具体内容，点一下 `jumpToSession(sid)` 切到对应会话，
  8 秒自动关闭；提示音（WebAudio）始终尝试播放。

### 2. 设置页重排成卡片式分组

- 顶部一大段说明收成一句短副标题 + 可展开「展开完整说明」按钮。
- 配置项按 **基础 / 微信机器人·投递目标 / 超时设置 / 提醒方式 / 在微信里直接选择 / 测试**
  分成 6 张卡片，统一圆角、间距、边框、中性配色（兼容深浅色）、主按钮蓝 / 次按钮灰。

### 3. 微信：按类别双超时 + 极简留底

- 「需选择 / 确认」独立 `attentionTimeoutSec`（默认 **60** 秒），「任务跑完」沿用
  `timeoutSec`（**30** 秒）。每条提醒自带 `deadline`，批次计时器对准最早到期项，
  到点只发已到期项、未到期项留到下一次，两类不串台。
- 超时微信砍成极简两段：【等你处理】（会话名 + 事件）/【已完成】
  （突出「会话「XXX」已完成」），末尾一句「别在这条下回复」，整条 ≤6 行，不再是文字墙。

### 4. 「微信里回 1 直接选」交 dsh-im 原生同步提问

- 本插件自己 `ctx.dshIm.send()` 发的微信结构上收不到回复（dsh-im 的 `consumeInbound`
  仅对飞书/Lark `exclusive-text-consumer` 开放，不暴露浏览器 RPC / HTTP）。
- 真回填由 **dsh-im 原生同步提问**完成：设置页给出一次性绑定步骤
  （dsh-im 设置打开双向同步 → 微信私聊发 `/sessionlist` 查会话 ID → `/session <会话ID>` 绑定），
  之后选项卡由 dsh-im 即时推送到该私聊，回「1」「选择 1」「批准」即回填、任务继续。
- 本插件超时消息只是留底，明确写了「别在这条下回复」，避免与 dsh-im 卡片打架。

---

## 包含的两个插件（没漏）

| 部分 | 作用 |
| --- | --- |
| 本包 `dsh-plugin-wechat-session` | 会话级监督、唯一浮层弹窗 + 提示音、双超时极简微信留底、卡片式设置页 |
| `@xmanrui/dsh-im`（`^5.10.0`，装伞包自动带上） | 微信机器人通道、原生同步提问 / 远程审批真回填 |

## 从旧版本升级

- 包名仍是 `dsh-plugin-wechat-session`，`pnpm update` 或重新安装即可。
- 已填的 Bot ID / 目标 ID / 超时秒数不丢：localStorage 三级回退
  `dshPluginWechatSession.config` → `dshSessionGuardian.config` → `dshWechatReminder.config`。
- client 半边代码在页面加载时注入，**升级后需重开 DSH 桌面端**才生效。

## 验证

- `node --check` 三文件通过；`node smoke/smoke-test.mjs` **54 项断言全通过**。
- 新增回归：m05207①「整轮不再 new Notification、只留一个弹窗」、
  m05207②「设置页卡片式分组可渲染」；m04774①「系统通知被拒绝时浮层仍弹出且可点跳会话」等。
- `npm pack --dry-run` = 14 文件；本机重开 DSH 后实测：唯一浮层 + 提示音 + 点击跳会话 +
  卡片式设置页全部正常。

## 自动发布（CI）

- `.github/workflows/publish.yml`：npm 可信发布（OIDC / provenance），
  `permissions.id-token: write` + Node 24 + `npm publish --provenance --access public`；
  推 main / 打 `v*` tag / 发 Release / 手动触发时先自检，再用幂等守卫
  `npm view "$NAME@$VERSION" version` 判断该版本是否已发布，未发布才发。
- `.github/workflows/sync-gitee.yml`：GitHub `main` 有 push 就自动把 main 与全部标签同步到 Gitee。
- 一次性前提：在 npmjs.com 为 `sweet560/dsh-plugin-wechat-session` 配置 Trusted Publisher
  （Workflow filename 填 `publish.yml`、Environment 留空）。配好后升版本号的 push 会由 OIDC 自动发版；
  未配置时 CI 发版步骤会失败，可本机用已登录的 npm 账号手动补发。
