# A 级 PoC：msgId 匹配命门验证报告

> 对应请求：先做一个 A 级 PoC 专门验证 msgId 匹配（不实施 A/B/C）。
> 版本：dsh-plugin-wechat-session v1.8.0（选项1 保持不动）；被测对象 `@xmanrui/dsh-im` 5.10.0。
> 运行方式：`node poc/msg-id-match.mjs`（纯离线，不连微信，依赖仅 Node 内置模块 + 本机 profile 的 dsh-im）。
> 实测结果：**14/14 断言通过**。

## 1. 为什么要做这个 PoC

评审结论里，A 方案（下行挂短标签 + 上行用现成「引用回复反查」回路由）的最小改动很诱人，
但有一个必须真机证伪的命门：**出站 `client_id` ≠ 入站引用 `msg_id`**。
本 PoC 不猜测、不自己复刻算法，而是直接 `import` dsh-im 5.10.0 的真实模块
（`weixin-api.mjs` / `state-store.mjs` / `weixin-bridge.mjs` / `shared/semantic/reply-reference.mjs` /
`shared/semantic/delivery.mjs`），把「反查算法本身」在离线环境跑一遍，量化它到底靠什么命中、
在什么条件下失效。

> dsh-im 的 package.json 未导出 `src/channels/` 深层，故用 `pathToFileURL` 直接指向真实源码文件。
> 这是「能直接调用就复用、不重复造轮子」准则的体现，保证结论与线上行为一致。

## 2. 关键事实（真实源码行号）

| 事实 | 源码位置 |
| --- | --- |
| 出站 `sendText` 生成 `clientId = \`dsh-weixin-${randomUUID()}\`` | `weixin-api.mjs:762` |
| 出站返回 `{ ..., providerMessageIds: [clientId] }`，**未解析服务端真实 msg_id** | `weixin-api.mjs:791-794` |
| `providerMessageIdsFor` 把该 clientId 数组取出存入 state | `shared/semantic/delivery.mjs:18-48` |
| `#send` 逐块 `rememberOutboundMessage({ providerMessageIds: chunkMessageIds })` | `weixin-bridge.mjs:1332-1341` |
| 入站引用 `messageId = String(quotedItem.msg_id)`（服务端数字串） | `weixin-api.mjs:908-910` |
| 反查 `recentOutboundTextFor`：先精确 `entry.providerMessageIds.includes(quotedMessageId)` | `state-store.mjs:247-251` |
| 再时间戳兜底 `quotedAt ∈ [sentAt-15000, completedAt+15000]` 且 `candidates.length === 1` | `state-store.mjs:252-263` |
| `msg_id` 时间戳解码 `Number(BigInt(value) >> 22n)`，限 16-20 位纯数字 | `weixin-api.mjs:935-947` |
| 兜底容差 `WEIXIN_RECENT_OUTBOUND_MATCH_TOLERANCE_MS = 15_000`，窗口 200 条 / 30 天 | `state-store.mjs:17-21` |
| 引用自带文本时直接返回 `content`，不调反查 | `weixin-api.mjs:905-906, 916-918` |
| 命中后以 `<dsh_im_reply_to>` 注入模型上下文 | `shared/semantic/reply-reference.mjs:129-137, 167` |
| 历史恢复成功后用**真实 msg_id** 回填 state（使后续精确匹配可命中） | `weixin-bridge.mjs:627-633` |

## 3. 七组实验与结论

### S1 出站身份（真实 `sendText` + mock 网络）
- 真实出站 `client_id = dsh-weixin-<uuid>`；服务端只回 `ret:0`，**不含 msg_id**。
- `providerMessageIdsFor(sendResult) === [clientId]` —— state 里存的就是 uuid。
- `weixinMessageTimestampMs(clientId) === null`（uuid 无法解码时间戳）。

### S2 入站 msg_id 身份
- 合法 iLink msg_id = `(ms<<22)+seq`，19 位纯数字，`>>22` 可解回毫秒时间戳。
- **`msg_id ≠ client_id`**：两者永不相等 → 精确 ID 匹配 `includes()` 必然失败。

### S3 单条下行、时间戳对齐
- 精确分支失败后，时间戳兜底有且仅有 1 条候选 → `recentOutboundTextFor` 返回下行原文。
- `replyBlock` 把含 `/session sid-A` 路由标签的原文注入 `<dsh_im_reply_to>`。
- **即：单条、时间对齐时，A 方案的回路由「碰巧能跑通」。**

### S4 msg_id 时间戳偏离 ±15s 容差
- 编码时间比出站早 1 分钟 → 兜底 0 候选 → 返回 `null`。
- `replyBlock` 退化为 `unavailableReason: not-delivered`，路由标签丢失。

### S5 多会话高频推送（核心证伪，对应截图场景）
- 同一收件人 3 条推送全落 ±15s 窗口 → `candidates.length === 3` → 返回 `null`。
- **多会话实时推送（下行多→一）正是「同收件人短时间多条」形态，A 方案在此拿不回路由标签。**
- 这是 A 级 PoC 最重要的负面结论：靠时间戳兜底的回路由，在目标场景里恰恰最不稳定。

### S6 补救路径：历史恢复回填真实 msg_id
- 复刻 `#loadReplyContent` 回填动作后，`entry.providerMessageIds.includes(msg_id)` 命中，
  即便时间戳偏离窗口也能精确返回原文。
- 但**首次引用仍依赖兜底/历史恢复成功**，不能解决冷启动与多候选问题。

### S7 对照：iLink ref_msg 自带被引用文本
- 构造 `quotedItem.text_item.text` 时，`extractWeixinReplyReference` 直接返回 `content`，
  `resolveContent`（即 msgId 反查）**根本不被调用**（用「一调用就抛错」的探针验证）。
- **这是决定 A 方案复杂度的真机第一问：若真实 iLink ref_msg 自带引用文本，命门根本不触发。**

## 4. 对 A/B/C 评审的回写

- **命门坐实**：`client_id ≠ msg_id`，精确匹配必失败（纯静态可证，已离线复现）。
- **A 方案不稳**：实际命中依赖「时间戳兜底 + 恰好 1 条候选」，而多会话实时推送（目标场景）
  天然制造多候选 → `null` → `not-delivered`。把并行路由压在这条兜底上不可靠。
- **维持「选项1 不动」的推荐**：在真机确认 `ref_msg` 是否自带文本之前，不值得为 A 改 dsh-im 核心
  （且改的是 node_modules，升级即丢，需 fork/patch 固化）。
- **不上 B/C**：与评审结论一致，无综合工程账更优的方案。

## 5. 真机待验证 TODO（本 PoC 无法离线覆盖）

1. `getUpdates` 返回的 `ref_msg.message_item` 是否含 `msg_id`（16-20 位）、`create_time_ms`、
   `text_item.text` —— 尤其第 7 组：是否自带被引用文本。
2. `msg_id >> 22` 解出的时间戳是否与出站时刻对齐，决定 ±15s 兜底是否可用。
3. 多会话推送并发时，用户引用回复能否稳定回路由。
   **建议**：若真机确认 `ref_msg` 自带文本，下行标签直接编码进推送正文即可，
   不依赖反查；否则应另找不依赖「恰好 1 条候选」的路由键，而非依赖兜底。

## 6. 复现

```bash
node poc/msg-id-match.mjs
```

脚本每次用独立临时目录构造 `WeixinStateStore`，互不污染；网络层仅 mock `fetch`
（其余全走 dsh-im 真实 `sendText`：base_url 校验、headers、retry、reject 判定）。
输出含每组断言与汇总，退出码非 0 表示断言失败。
