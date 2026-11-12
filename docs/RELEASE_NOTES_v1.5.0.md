# v1.5.0 发布说明（微信会话互通 · 首个正式版本）

发版日期：2026-11-11
npm 包：`dsh-plugin-wechat-session@1.5.0`
仓库：GitHub `sweet560/dsh-plugin-wechat-session` / Gitee `wtt520wyl/dsh-plugin-wechat-session`

---

## 这个插件是做什么的

给 **DeepSeek Harness 桌面端**用的「会话监督 + 联动提醒」聚合包。它会盯着你所有正在跑的会话：

- 哪条会话**需要你确认权限**、**需要你手动选择**、或者**任务跑完了**，都弹一张**带具体内容**的
  系统通知并响提示音；
- **点那张通知就能直接切到对应会话界面**，不用自己在会话列表里找；
- 如果桌面提醒发出后 **30 秒**还没切过去看 / 没把待办处理掉，就通过 **dsh-im 的微信机器人
  （普通微信）**把汇总提醒发到你指定的那一个微信对话。

装这一个包，就同时带上了「微信会话互通」和 `@xmanrui/dsh-im`（微信机器人）两个插件。

---

## 包含的两个插件（没漏）

| 组成部分 | 来源 | 作用 |
| --- | --- | --- |
| 微信会话互通（本包） | 本仓库 `lib/index.js` + `lib/client.js` | 监督全部会话的三类事件、桌面弹窗 + 提示音、30 秒超时汇总、设置页、点击跳会话 |
| `@xmanrui/dsh-im` | npm 官方源，声明为 `^5.10.0` 可升级依赖 | 普通微信机器人，负责把超时汇总真正发到微信 |

`cordis.patch.yml` 一个 `insert` 挂两条 loader 行（本插件 + dsh-im），两者代码各自独立，
没有把 dsh-im 那 29 MiB、带原生模块的源码物理复制进来。dsh-im 继续走 npm 官方源、可单独升级。

---

## 主要特性

- **三类触发全覆盖**：需要确认权限 / 需要手动选择 / 任务跑完（模型这一轮回复结束）。
- **带具体内容的通知**：标题「会话名 · 事件标签」（正在申请权限 / 模型在等你回答 / 对话完成），
  正文是从 `pendingInteraction` 抽出的问题文本 / 工具名 + 原因，最长 160 字；抽不到时回退中文说明。
- **点击跳会话**：所有系统通知的 `onclick` 走 `uiWorkspace.openSession(sid)` + `window.focus()`
  + Electron `dsh://open` 唤起窗口（照抄 dsh-pet 已验证写法）。
- **会话级监督**：窗口前台时只提醒「没在看」的那些会话，正盯着的那条保持安静；窗口整个切到
  后台时所有会话都提醒。修复了「3 条会话并行、界面停在一条时其他 2 条不通知也不发微信」的 bug。
- **会话级「已响应」**：切到对应会话去看、或把那条待办处理掉，就取消微信补发；前台 30 秒没理
  照样发微信。
- **微信兜底可配置**：Bot ID + 目标 ID、超时秒数、提示音 / 音量、总开关都在设置页；
  「复制调用参数」整段 JSON 可直接粘进任意一栏自动拆分；英文报错已中文化。
- **不依赖外部 Webhook**：微信推送走 DSH 里已接入的微信机器人主动投递，不需要 Server 酱 / SendKey。

---

## 从旧版 dsh-wechat-reminder 升级

本机旧包名是 `dsh-wechat-reminder`。改名重装后，浏览器半边会优先读新 localStorage key
`dshPluginWechatSession.config`，为空时回退读旧 key `dshWechatReminder.config`：
**已填的 Bot ID / 目标 ID / 超时秒数不会丢**，无需重新填。旧 key 保留不清，避免误删。

---

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

- `npm test`：离线冒烟测试（本版本共 40 项断言，含改名迁移回归、三类通知、会话级规则、
  整段 JSON 自动拆分、错误中文化、点击跳会话等）。
- `npm pack --dry-run`：确认发布文件清单。
- `.github/workflows/publish.yml`：推 main / 打 `v*` tag / 发 Release 时，自检通过后用幂等守卫
  判断该版本是否已发布，未发布且配了 `NPM_TOKEN` 才自动 `npm publish`。
  没改版本号的 push 自动跳过，不会因 npm 版本不可变报错。

---

## 自动发布的一次性配置

在 GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加：

- `NPM_TOKEN`：npmjs.com 上属于包 owner、对本包有 publish 权限的 **Automation token**。
  不要设置 Allowed IP ranges 白名单（GitHub-hosted runner 出口 IP 不固定）。

配好后，重大更新只要**把 `package.json` 的 `version` 升成 registry 上还不存在的新值**并推到
main / 打 `v*` tag，CI 就会自动把它发布到 npm。
