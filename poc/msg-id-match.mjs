/**
 * A 级 PoC：专门验证「msgId 匹配」命门
 * ---------------------------------------------------------------------------
 * 背景（评审结论）：A 方案 = 下行挂短标签 + 上行用现成「引用回复反查」回路由，
 * 命门在于 —— 微信通道出站存的是 client_id（`dsh-weixin-<uuid>`），
 * 而入站引用 replyTo.messageId 是服务端数字 msg_id，两者永不相等。
 * 本 PoC 用 @xmanrui/dsh-im 5.10.0 的【真实模块】离线证伪/证实这件事，
 * 并量化「时间戳兜底」在多会话高频推送下的稳定性。
 *
 * 用法：node poc/msg-id-match.mjs
 * 依赖：仅 Node.js 内置模块 + 本机已安装的 @xmanrui/dsh-im（profile 的 node_modules）。
 *       dsh-im 的 package.json 未导出 src 深层，故用 pathToFileURL 直接指真实文件路径。
 *
 * 注意：本脚本【不连微信】，纯离线。它验证的是「反查算法本身」的行为；
 *       iLink ref_msg 是否真带 msg_id / 文本摘要 / 时间戳，需真机确认（见末尾 TODO）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// —— 全部指向 dsh-im 真实源码，不复制任何实现 ——
const IM = 'F:/DeepSeek Harness workspace/profiles/desktop/node_modules/@xmanrui/dsh-im/src/channels/';
const u = (f) => pathToFileURL(IM + f).href;

const {
  createWeixinApi,
  extractWeixinReplyReference,
  extractWeixinText,
  weixinMessageTimestampMs,
} = await import(u('weixin/weixin-api.mjs'));
const { WeixinStateStore } = await import(u('weixin/state-store.mjs'));
const { weixinInboundMessage } = await import(u('weixin/weixin-bridge.mjs'));
const { providerMessageIdsFor } = await import(u('shared/semantic/delivery.mjs'));
const { promptContentForInboundMessage } = await import(u('shared/semantic/reply-reference.mjs'));

// —— 小工具 ——
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log(`  ✅ ${name}`); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log(`  ❌ ${name} → ${e.message}`); }
}
const TO = 'wxuser_real_target_001';                 // 微信侧唯一收件人（1:1 会话的根）
const LABEL_A = '【会话A sid-A】请处理任务 X（/session sid-A 切换）'; // 模拟下行挂了短标签
const LABEL_B = '【会话B sid-B】请处理任务 Y（/session sid-B 切换）';
const LABEL_C = '【会话C sid-C】请处理任务 Z（/session sid-C 切换）';

/** 造一个合法的 iLink 数字 msg_id：高位是毫秒时间戳（<<22），低位是序号。 */
function encodeMsgId(ts, seq = 7) {
  return (BigInt(ts) << 22n) + BigInt(seq);
}
/** 造一个真实 state（每次独立临时文件，互不污染）。 */
async function freshState() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-poc-'));
  const store = new WeixinStateStore(join(dir, 'state.json'));
  await store.load();
  return { dir, store };
}
/** 构造一条真实形态的入站「引用回复」消息。
 *  quotedItem 故意【不带任何文本 / 附件】，强制走 resolveContent(=recentOutboundTextFor) 反查，
 *  以此隔离测试「msgId/时间戳匹配」这条路径。 */
function inboundRef(msgId, userText = '帮我继续这个会话', quotedText = null) {
  const quotedItem = {
    msg_id: String(msgId),
    type: 1, // 文本型，属于 knownType；但下面不给 text_item，逼反查
    ...(quotedText ? { text_item: { text: quotedText } } : {}),
  };
  return {
    from_user_id: TO,
    item_list: [
      { type: 1, text_item: { text: userText } }, // 用户本条追问
      { ref_msg: { message_item: quotedItem } },  // 引用的那条下行推送
    ],
  };
}
/** 把真实 inbound 转成实际注入模型的 replyBlock 文本（复用真实 prompt 组装）。 */
async function replyBlockOf(store, msgId, quotedText = null) {
  const raw = inboundRef(msgId, undefined, quotedText);
  const inbound = weixinInboundMessage(raw, null, store);
  const blocks = await promptContentForInboundMessage({
    content: extractWeixinText(raw) ?? inbound.content,
    replyTo: inbound.replyTo,
    images: [],
    files: [],
  });
  return blocks.find((b) => b.type === 'text' && b.text.startsWith('<dsh_im_reply_to>'))?.text ?? '';
}

// ===========================================================================
console.log('\n========== S1 出站身份：真实 sendText 到底存了什么 ==========');
// mock 掉网络，其余全部走 dsh-im 真实 sendText（含 base_url 校验、headers、retry、reject 判定）
let captured = null;
const mockFetch = async (_url, options) => {
  captured = JSON.parse(options.body).msg;
  return { ok: true, json: async () => ({ ret: 0 }) }; // 服务端只回 ret:0，不给真实 msg_id
};
const api = createWeixinApi({ fetchImpl: mockFetch });
const sendResult = await api.sendText({
  baseUrl: 'https://ilink.weixin.qq.com/', token: 'fake-token', toUserId: TO, text: LABEL_A,
});
const clientId = captured.client_id;
const storedIds = providerMessageIdsFor(sendResult); // 真实提取函数（#send 用的就是它）

console.log(`  真实出站 client_id  = ${clientId}`);
console.log(`  sendText 返回        = ${JSON.stringify(sendResult)}`);
console.log(`  providerMessageIdsFor = ${JSON.stringify(storedIds)}`);
check('出站 client_id 是 dsh-weixin-<uuid> 字符串（非数字 msg_id）', () => {
  assert.match(clientId, /^dsh-weixin-[0-9a-f-]{36}$/);
});
check('出站只把 client_id 当 providerMessageIds 存入（服务端未回 msg_id）', () => {
  assert.deepEqual(storedIds, [clientId]);
});
check('client_id 无法被 weixinMessageTimestampMs 解码（不含时间戳）', () => {
  assert.equal(weixinMessageTimestampMs(clientId), null);
});

// ===========================================================================
console.log('\n========== S2 入站 msg_id 身份：与出站 client_id 是否同一个东西 ==========');
const T0 = Date.now();
const msgId = encodeMsgId(T0);
const msgIdStr = String(msgId);
console.log(`  构造真实 msg_id     = ${msgIdStr}（${msgIdStr.length} 位）`);
console.log(`  解码出的时间戳      = ${weixinMessageTimestampMs(msgIdStr)} (期望≈${T0})`);
check('msg_id 是 16-20 位纯数字，可被 >>22 解码回毫秒时间戳', () => {
  assert.match(msgIdStr, /^\d{16,20}$/);
  assert.equal(weixinMessageTimestampMs(msgIdStr), T0);
});
check('msg_id ≠ client_id（这就是命门：两者永不相等）', () => {
  assert.notEqual(msgIdStr, clientId);
});

// ===========================================================================
console.log('\n========== S3 单条下行：靠时间戳兜底能否反查回原文 ==========');
{
  const { dir, store } = await freshState();
  // 完全复刻 #send：用真实 providerMessageIdsFor 的结果灌进 state
  await store.rememberOutboundMessage({
    toUserId: TO, text: LABEL_A, sentAt: T0, completedAt: T0,
    providerMessageIds: storedIds,
  });
  // 精确 ID 匹配：client_id 里没有 msg_id → 必然不命中
  const exactHit = store.recentOutboundTextFor({ toUserId: TO, messageId: 'definitely-not-a-real-id' });
  console.log(`  仅凭一个不存在的 ID 反查（隔离精确分支） = ${JSON.stringify(exactHit)}`);
  check('精确 ID 分支：client_id 数组里查 msg_id → null（精确匹配必失败）', () => {
    assert.equal(exactHit, null);
  });
  // 真实入站（msg_id 时间戳恰落在出站容差窗口）→ 时间戳兜底 1 候选 → 命中原文
  const hit = store.recentOutboundTextFor({ toUserId: TO, messageId: msgIdStr });
  const block = await replyBlockOf(store, msgId);
  console.log(`  recentOutboundTextFor(真实 msg_id) = ${JSON.stringify(hit)}`);
  console.log(`  replyBlock = ${block}`);
  check('单条下行 + 时间戳对齐 → 时间戳兜底命中，反查回原文', () => {
    assert.equal(hit, LABEL_A);
  });
  check('replyBlock 把下行原文（含 /session 路由标签）注入模型上下文', () => {
    assert.ok(block.includes('<dsh_im_reply_to>'));
    assert.ok(block.includes('sid-A'));
  });
  await rm(dir, { recursive: true, force: true });
}

// ===========================================================================
console.log('\n========== S4 msg_id 时间戳偏离 15s 容差窗口：兜底失效 ==========');
{
  const { dir, store } = await freshState();
  await store.rememberOutboundMessage({
    toUserId: TO, text: LABEL_A, sentAt: T0, completedAt: T0, providerMessageIds: storedIds,
  });
  const lateMsgId = encodeMsgId(T0 - 60_000); // 编码时间比出站早 1 分钟（超出 ±15s）
  const hit = store.recentOutboundTextFor({ toUserId: TO, messageId: String(lateMsgId) });
  const block = await replyBlockOf(store, lateMsgId);
  console.log(`  偏离窗口后反查 = ${JSON.stringify(hit)}`);
  console.log(`  replyBlock = ${block}`);
  check('精确匹配失败 + 时间戳兜底 0 候选 → null，路由标签丢失', () => {
    assert.equal(hit, null);
  });
  check('replyBlock 退化为 unavailableReason: not-delivered（无原文）', () => {
    assert.ok(block.includes('not-delivered'));
    assert.ok(!block.includes('sid-A'));
  });
  await rm(dir, { recursive: true, force: true });
}

// ===========================================================================
console.log('\n========== S5 多会话高频推送：同一收件人短时间内多条 → 多候选崩溃（核心证伪） ==========');
{
  const { dir, store } = await freshState();
  // 模拟截图场景：多会话实时推送在 21:31 附近连发多条给同一个微信用户
  const pushes = [
    { text: LABEL_A, t: T0 - 3_000 },
    { text: LABEL_B, t: T0 },
    { text: LABEL_C, t: T0 + 3_000 },
  ];
  for (const p of pushes) {
    await store.rememberOutboundMessage({
      toUserId: TO, text: p.text, sentAt: p.t, completedAt: p.t,
      providerMessageIds: [`dsh-weixin-${p.t}`], // 每条都是各自的 client_id
    });
  }
  const snapshot = store.snapshot().recentOutboundMessages.length;
  const hit = store.recentOutboundTextFor({ toUserId: TO, messageId: msgIdStr });
  const block = await replyBlockOf(store, msgId);
  console.log(`  state 内该收件人的出站条数 = ${snapshot}`);
  console.log(`  反查 = ${JSON.stringify(hit)}（3 条全落 ±15s 容差 → candidates.length=3）`);
  console.log(`  replyBlock = ${block}`);
  check('多条候选同时落窗口 → candidates.length!==1 → 返回 null', () => {
    assert.equal(hit, null);
    assert.equal(snapshot, 3);
  });
  check('replyBlock 只剩 not-delivered：A 方案在多会话推送下拿不回路由标签', () => {
    assert.ok(block.includes('not-delivered'));
    assert.ok(!block.includes('sid-'));
  });
  await rm(dir, { recursive: true, force: true });
}

// ===========================================================================
console.log('\n========== S6 补救路径：历史恢复用真实 msg_id 回填后，精确匹配可命中 ==========');
{
  const { dir, store } = await freshState();
  await store.rememberOutboundMessage({
    toUserId: TO, text: LABEL_A, sentAt: T0, completedAt: T0, providerMessageIds: storedIds,
  });
  // 复刻 #loadReplyContent 命中历史后的回填动作：providerMessageIds 用【真实 msg_id】
  const lateMsgId = encodeMsgId(T0 - 60_000); // 时间戳故意偏离窗口，证明精确匹配不再依赖它
  await store.rememberOutboundMessage({
    toUserId: TO, text: LABEL_A, sentAt: T0, completedAt: T0,
    providerMessageIds: [String(lateMsgId)],
  });
  const hit = store.recentOutboundTextFor({ toUserId: TO, messageId: String(lateMsgId) });
  console.log(`  回填真实 msg_id 后反查 = ${JSON.stringify(hit)}`);
  check('回填后 entry.providerMessageIds.includes(msg_id) 命中 → 精确匹配返回原文', () => {
    assert.equal(hit, LABEL_A);
  });
  await rm(dir, { recursive: true, force: true });
}

// ===========================================================================
console.log('\n========== S7 对照：若 iLink ref_msg 自带被引用文本，则根本不走 msgId 反查 ==========');
{
  // 传一个「一旦被调用就抛错」的 resolveContent，验证它没被触发
  const raw = inboundRef(msgId, undefined, LABEL_A); // quotedItem 带 text_item.text
  const ref = extractWeixinReplyReference(raw, {
    resolveContent: () => { throw new Error('反查被误触发'); },
  });
  console.log(`  extractWeixinReplyReference = ${JSON.stringify(ref)}`);
  check('引用自带文本 → 直接返回 content，resolveContent（msgId 反查）不被调用', () => {
    assert.equal(ref.content, LABEL_A);
    assert.equal(ref.messageId, msgIdStr);
  });
}

// ===========================================================================
const pass = results.filter((r) => r.ok).length;
console.log('\n======================== 汇总 ========================');
console.log(`  断言：${pass}/${results.length} 通过`);
console.log('  结论：');
console.log('   · 出站身份是 client_id(uuid)，入站引用是服务端 msg_id —— 精确 ID 匹配必然失败。');
console.log('   · 反查实际只靠「时间戳兜底 + 恰好 1 条候选」：单条且时间对齐时能命中；');
console.log('     时间戳偏离 ±15s、或同一收件人短时间多条推送（多会话实时推送正是此形态）即返回 null。');
console.log('   · 只有用真实 msg_id 回填过（历史恢复成功）后，精确匹配才稳定 —— 但首次仍依赖兜底。');
console.log('   · 决定 A 方案复杂度的真机第一问：iLink ref_msg 是否自带被引用文本？若自带，命门根本不触发。');
console.log('  真机待验证 TODO：');
console.log('   1) getUpdates 的 ref_msg.message_item 是否含 msg_id（16-20 位）、create_time_ms、text_item.text；');
console.log('   2) msg_id >>22 解出的时间戳是否与出站时刻对齐（决定 ±15s 兜底是否可用）；');
console.log('   3) 多会话推送并发时，用户引用回复能否稳定回路由（建议下行标签不依赖反查、直接编码进引用文本或就近上下文）。');
if (pass !== results.length) process.exitCode = 1;
