# v1.6.0 发布说明（微信会话互通 · 行为修复 + 可信发布）

发版日期：2026-11-12
npm 包：`dsh-plugin-wechat-session@1.6.0`
仓库：GitHub `sweet560/dsh-plugin-wechat-session` / Gitee `wtt520wyl/dsh-plugin-wechat-session`

---

## 这个版本做了什么

v1.6.0 在 v1.5.0 的功能基础上，修了两个实测出来的行为问题，并把「重大更新自动发 npm」和
「GitHub main 自动同步到 Gitee」两条流水线补齐、改成更安全的形态，同时把插件提交到
DSH 插件市场收录。**桌面弹窗 / 提示音 / 30 秒微信兜底 / 会话级规则全部保留不变。**

### 1. 忽略后台委托 / 子代理会话（不再误报）

- 现象：Mnemon 的「自进化」会在后台创建「落盘的任务及子代理会话」，会话名带
  `[dsh-mnemon:delegated skill]` 这类前缀。v1.5.0 会把它们当成普通对话，弹窗、响提示音，
  30 秒后还补发一条微信汇总。
- 修复：在提醒的唯一入口 `noteAlert()` 最前面加 `isIgnoredSession(sid)`，按宿主既有判据
  （`origin === 'subagent'` / `delegationDepth > 0` / `parentId` 存在 / 稳定前缀
  `[dsh-mnemon:delegated `）判定并静默——**不提醒、不弹窗、也不发微信**。
- 判据与 dsh-pet 的 `shouldNotifySession()`、dsh-rewind-plugin 的 `isSubagentSession()`、
  宿主 `sessionVisible()` 一致；Mnemon 也把该前缀声明为稳定可依赖的排除依据。
- 普通会话（无上述标记）完全不受影响；冒烟测试覆盖 7 类后台会话 + 1 个普通会话对照组。

### 2. 治本修复「窗口在后台时需要确认 / 选择却不弹窗也不响」

- 现象：窗口切到后台 / 切到别的程序时，会话弹出「需要我选择 / 确认」的卡片，却没有桌面
  弹窗、也没有提示音；但微信汇总过 30 秒照常到达。
- 根因（三句话）：
  1. `toast()` 把 `new Notification` 卡在 `Notification.permission === 'granted'`，而申请权限
     只在「第一次点击 / 按键」里做一次、之后不重试；DSH 重开会换端口 → 新 origin → 权限
     回到 `default`，窗口又在后台 → 永久不弹。
  2. 通知参数 `silent: true` 关掉了系统提示音，声音全压在 WebAudio `playCue()` 上，而它
     要求 `audioCtx.state === 'running'`，解锁同样只在首次手势做一次。
  3. 微信走 HTTP 回环，不依赖这两道门槛，所以照常到达；外层 `catch(e){}` 空吞，让故障
     看起来像「突发异常」。
- 修复（对齐 dsh-pet 的 `initNotify()`）：
  - **启动即主动申请通知权限**（`ensurePermission(); unlockAudio();` 放在激活阶段，不依赖
    用户先点一下窗口）；每次提醒前也会重试申请 / 解锁。
  - 去掉 `silent: true`，让**系统通知音兜底**；WebAudio 提示音仍保留，两者叠加优先保证听得到。
  - 失败写日志（`noteLog()`），不再空吞；`debug()` 暴露
    `notifyPermission / notifySound / audioState / permissionPending` 便于实测。
  - 权限被系统拒绝（`denied`）时给出中文提示，引导到系统设置里允许 DSH 通知。

---

## 包含的两个插件（没漏）

| 组成部分 | 来源 | 作用 |
| --- | --- | --- |
| 微信会话互通（本包） | 本仓库 `lib/index.js` + `lib/client.js` | 监督全部会话的三类事件、桌面弹窗 + 提示音、30 秒超时汇总、设置页、点击跳会话 |
| `@xmanrui/dsh-im` | npm 官方源，声明为 `^5.10.0` 可升级依赖 | 普通微信机器人，负责把超时汇总真正发到微信 |

`cordis.patch.yml` 一个 `insert` 挂两条 loader 行（本插件 + dsh-im），两者代码各自独立。

---

## 发布流水线（本版重点）

### GitHub main → Gitee 自动同步

`.github/workflows/sync-gitee.yml`（新增）：`main` 每次 push 或手动触发时，`checkout` 取全
历史与标签，用仓库 Secret `GITEE_SSH_PRIVATE_KEY` 里的 **OpenSSH 私钥本体**通过 SSH 把
`main` 与全部标签 `--force --prune` 推到 `git@gitee.com:wtt520wyl/dsh-plugin-wechat-session.git`。
私钥安装步骤会做首行类型诊断与 `ssh-keygen -y -f` 校验（公钥 / PPK / 带口令都报错退出）。

### npm 可信发布（OIDC / provenance）

`.github/workflows/publish.yml`（由 `NPM_TOKEN` 版整体改为 OIDC 版）：

- `permissions: contents: read, id-token: write`（OIDC 必需）。
- `actions/checkout@v7` / `actions/setup-node@v7` 用 **Node 24（Active LTS）**，
  先 `npm install -g npm@latest` 保证 npm ≥ 11.5.1。
- 触发：push main / 打 `v*` tag / 发布 Release / `workflow_dispatch`。
- 先 `npm test` 自检，再用幂等守卫 `npm view "$NAME@$VERSION" version` 判断该版本是否已发布；
  没改版本号的 push 自动跳过，不会因 npm 版本不可变报错。
- 末步 `npm publish --provenance --access public`，**不设 `NODE_AUTH_TOKEN` / `NPM_TOKEN`**，
  由 OIDC 换取短期凭证并附带 provenance 签名。

**一次性前提（npmjs.com 网页配置，CI 无法代劳）**：为包
`dsh-plugin-wechat-session` 添加 Trusted Publisher —— Organization/user 填 `sweet560`、
Repository 填 `dsh-plugin-wechat-session`、**Workflow filename 必须逐字填 `publish.yml`**、
Environment name 留空；`package.json` 的 `repository.url` 已与该 GitHub 仓库一致。
未配置时 CI 会以 404 / 鉴权失败告终，不会自动降级到 token 发布。

**注意「先有鸡还是先有蛋」**：npm 要求包先存在才能配置 Trusted Publisher，OIDC 无法做
全新包名的首次发布。本包是改名为 `dsh-plugin-wechat-session` 后的全新 npm 名字，所以
**1.6.0 首版用本机已登录的 npm 账号手动 `npm publish --access public` 建包**（不带
provenance）；建包、配好 Trusted Publisher 之后，后续升版本号的 push / tag 才由
workflow 用 OIDC 自动发布。

### 市场收录

- GitHub 仓库 Topics 补齐为 10 个（`dsh-plugin` / `deepseek-harness` / `notification` /
  `provenance` / `reminder` / `session` / `wechat` 等）。
- 向 `awesome-dsh-plugin` 目录提交一个 `data/plugins/sweet560__dsh-plugin-wechat-session.yml`
  收录 PR（DSH 站内插件市场 `dshmarket` 会自动抓取该目录，通常一天内可见）。

---

## 从旧版升级

- 从 `dsh-wechat-reminder`（旧名）升级：浏览器半边优先读新 localStorage key
  `dshPluginWechatSession.config`，为空时回退读旧 key `dshWechatReminder.config`，**已填的
  Bot ID / 目标 ID / 超时秒数不会丢**。
- 从 v1.5.0 升级：无需改配置；本版两项修复都在代码里，重开 DSH 桌面端即生效。

## 安装

```bash
dsh plugin --profile desktop add dsh-plugin-wechat-session
# 或本地源码安装：
dsh plugin --profile desktop add "file:F:/.../dsh-plugin-wechat-session"
```

装完**重开 DSH 桌面端**，再到 设置 → 微信会话互通 填写 Bot ID / 目标 ID，
用「测试桌面通知」「测试微信推送」验证链路。

---

## 验证

- `npm test`：离线冒烟测试共 **45 项断言**（含本版两项修复的回归：7 类后台会话静默 +
  普通会话对照组、权限丢回 default 时仍主动申请并弹窗、debug 诊断字段；以及改名迁移、
  三类通知、会话级规则、整段 JSON 自动拆分、错误中文化、点击跳会话等）。
- `npm pack --dry-run`：确认发布文件清单（含本文件）。
- `node --check lib/index.js lib/client.js`：语法检查。
