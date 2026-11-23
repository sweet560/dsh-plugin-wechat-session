// dsh-plugin-wechat-session 冒烟测试（纯 Node，无需真实 DSH 宿主）。
// 运行：npm test
//
// 覆盖：
//   1. 清单契约（package.json / cordis.patch.yml / locale / icon）—— v2.1.0 单插件、无 dsh-im
//   2. lib/host/bridge.js：会话前缀寻址、待决池幂等结算、permissionPreset 降级、延迟提醒上限
//   3. Host half：8 条路由注册、准入裁决、iLink 投递、扫码登录、/new 薄创建、seam 订阅
//   4. Client half：模块包装导出、配置读写、设置页与 watchers 能无异常挂载、历史回归

import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { sessionPrefix, parseInbound, ApprovalRegistry, createBridge, humanizeError } from '../lib/host/bridge.js';
import { createBindingStore } from '../lib/host/binding-store.js';
import { createSettingsStore } from '../lib/host/settings-store.js';
import { createTransport } from '../lib/channel/transport.js';

const root = new URL('../', import.meta.url);
const readText = (p) => readFile(new URL(p, root), 'utf8');
const readJson = async (p) => JSON.parse(await readText(p));
let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

// ───────────────────── 1. 清单 / 静态文件 ─────────────────────
const pkg = await readJson('package.json');
assert.equal(pkg.name, 'dsh-plugin-wechat-session');
assert.equal(pkg.version, '2.2.2');
assert.equal(pkg.type, 'module');
assert.equal(pkg.main, 'lib/index.js');
assert.equal(pkg.icon, 'icon.svg');
assert.equal(pkg.dsh.manifestVersion, 1);
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(pkg.dsh.client.platform, 'web');
assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length >= 1);
assert.equal(pkg.exports['.'], './lib/index.js');
assert.equal(pkg.exports['./client'], './lib/client.js');
ok('package.json 基本字段与 dsh 声明（v2.1.0 通道外设版：/new 薄创建 + 多会话并行审批）');

// v2.0.0：彻底去除 dsh-im 聚合依赖，单插件独立运行（纯 iLink + 官方 seam）
assert.equal(pkg.dependencies?.['@xmanrui/dsh-im'], undefined, 'v2.0.0 不应再依赖 @xmanrui/dsh-im');
assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, '不应有任何运行时依赖（纯 iLink 零依赖）');
assert.ok(pkg.files?.includes('lib/channel/ilink.mjs'), 'files 应含 iLink 协议层');
assert.ok(pkg.files?.includes('lib/channel/transport.js'), 'files 应含通道适配器');
assert.ok(pkg.files?.includes('lib/host/bridge.js'), 'files 应含宿主事件/审批桥');
assert.ok(pkg.files?.includes('lib/host/binding-store.js'), 'files 应含绑定状态持久化模块');
assert.ok(pkg.files?.includes('lib/host/settings-store.js'), 'files 应含设置持久化模块（/new 工作目录）');
assert.ok(pkg.files?.includes('vendor/qrcode.cjs'), 'files 应含内置二维码库（内嵌扫码，零 npm 依赖）');
ok('去 dsh-im：无运行时依赖，files 含三模块 + 两个持久化 store + 内置二维码库');

// 宿主兼容：不声明 engines.dsh（否则宿主只按它判定，跨 RC 会整行禁用）
assert.equal(pkg.engines.dsh, undefined, '不要声明 engines.dsh');
// 市场受管约束：不得出现 cordis 依赖、不得有安装期脚本
for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  const deps = pkg[field] || {};
  for (const name of Object.keys(deps)) {
    assert.ok(!/^cordis$/.test(name), `${field} 不得含 cordis`);
  }
}
for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
  assert.equal(pkg.scripts?.[script], undefined, `scripts 不得含 ${script}`);
}
ok('市场受管约束（无 cordis 依赖 / 无安装期脚本 / 不声明 engines.dsh）');

const patch = await readText('cordis.patch.yml');
assert.match(patch, /- insert:/);
assert.match(patch, /id: dsh-plugin-wechat-session/);
assert.match(patch, /name: 'dsh-plugin-wechat-session'/);
assert.match(patch, /prefixLength: 6/, 'patch 应含 prefixLength 配置');
assert.match(patch, /approvalTimeoutMs: 300000/, 'patch 应含回填窗口配置（5 分钟）');
assert.ok(!/botId:/.test(patch), 'patch 不应再有 botId（改扫码登录）');
assert.ok(!/targetId:/.test(patch), 'patch 不应再有 targetId（改扫码登录）');
assert.ok(!/sendKey/.test(patch), 'patch 不应再有 sendKey');
ok('cordis.patch.yml 单条挂载行 + prefixLength/approvalTimeoutMs（去 botId/targetId，改扫码）');

// v2.0.0：单插件，不再挂 dsh-im 第二条 entry
const entryNameMatches = patch.match(/^\s*- id:/gm) || [];
assert.equal(entryNameMatches.length, 1, 'patch 应恰好一条 loader entry（单插件）');
assert.ok(!/@xmanrui\/dsh-im/.test(patch), 'patch 不应再引用 dsh-im');
assert.ok(!/disabled: !!js/.test(patch), '单插件不需要防重守卫');
ok('单插件：一条 loader entry，无 dsh-im、无防重守卫');

for (const loc of ['en', 'zh']) {
  const dict = await readJson(`locale/${loc}.json`);
  assert.ok(dict.meta?.title, `${loc}.json 缺 meta.title`);
  assert.ok(dict.meta?.description, `${loc}.json 缺 meta.description`);
  assert.ok(!/ServerChan|Server 酱/i.test(dict.meta.description), `${loc}.json 不应再提 Server 酱`);
}
ok('locale/en.json + zh.json（en 为发现基线，描述已改 dsh-im）');

const icon = await readText('icon.svg');
assert.match(icon, /<svg[\s\S]*viewBox="0 0 64 64"[\s\S]*width="64"[\s\S]*height="64"/);
// m01567：用 dsh-plugin-yanyan-icon 的 buildIconSvg 生成——64×64 自包含静态 SVG。
assert.match(icon, /#07C160/i, 'icon.svg 应为微信绿底');
assert.match(icon, /data:image\/png;base64,/, 'logo 应为内嵌的 PNG 位图');
assert.match(icon, /<image[\s\S]*xlink:href=[\s\S]*data:image\/png;base64,/, '应为内嵌位图的 image 元素');
assert.ok(!/<script|foreignObject|currentColor/i.test(icon), '图标不应含脚本/外链/动态色');
ok('icon.svg 64×64 微信官方图标（工具生成，微信绿底 + 内嵌双气泡位图）');

// 代码里彻底不再有 Server 酱调用痕迹（配置键 / URL / 出库 fetch）
for (const f of ['lib/index.js', 'lib/client.js']) {
  const src = await readText(f);
  assert.ok(!/sctapi|sct\.ftqq\.com|ServerChan|serverchan/i.test(src), `${f} 不应残留 Server 酱调用`);
  assert.ok(!/\bsendKey\b/.test(src), `${f} 不应残留 sendKey 标识符`);
  assert.ok(!/globalThis\.fetch|fetch\(['"]https:/.test(src), `${f} 不应有外部 Webhook fetch`);
}
ok('代码彻底移除 Server 酱 / sctapi / sendKey（改走 iLink）');

// ───────────────────── 2. Host half（v2.1.0 通道外设版）─────────────────────
const host = await import(new URL('../lib/index.js', import.meta.url).href);
assert.equal(host.name, 'dsh-plugin-wechat-session');
assert.equal(host.VERSION, '2.2.2', '版本须为 2.2.2');
assert.deepEqual(host.inject, ['webServer', 'connection']);
assert.equal(typeof host.apply, 'function');
for (const r of ['WECHAT_ROUTE','HEALTH_ROUTE','LOGIN_ROUTE','LOGIN_STATUS_ROUTE','INBOUND_ROUTE','SESSIONS_ROUTE','QR_IMAGE_ROUTE','SETTINGS_ROUTE']) {
  assert.match(host[r], /^\/__dsh-plugin-wechat-session\//, `${r} 应为插件路由`);
}
ok('lib/index.js 导出 name/VERSION=2.1.0/inject/apply/8 条路由常量（含 SETTINGS_ROUTE）');

// ── 2A. bridge.js 单元：sessionPrefix / parseInbound / ApprovalRegistry ──
assert.equal(sessionPrefix('3f2a-9bcc-11dd'), '3f2a9b', '前缀应去非字母数字取前6位并小写');
assert.equal(sessionPrefix('AB-CD', 4), 'abcd');
// 回归【前缀碰撞】：真实会话 ID 多为 session-<uuid>，跳过公共开头避免全撞成 sessio
const collisionA = sessionPrefix('session-91b2175-db79-4ec0-9bf6-dd44446ebe45');
const collisionB = sessionPrefix('session-4bf2c3c3-e3f3-4d0a-9383-bfeb770d5e81');
assert.notEqual(collisionA, collisionB, 'session- 开头的不同会话前缀不应碰撞');
assert.equal(collisionA, '91b217', '应跳过 session- 公共开头取 UUID 段前6位');
assert.equal(collisionB, '4bf2c3');
assert.equal(sessionPrefix('session-ab'), 'ab', '短 ID 跳过开头后仍有内容时正常返回');
ok('sessionPrefix：去非字母数字 + 小写 + 截长 + 跳过 session- 公共开头防碰撞');

// 回归【错误中文化】：底层英文错误发微信前必须转成中文（用户看不懂英文）
assert.match(humanizeError('session "session-ac2a3e51-25c8-4476-8935-69c29c226b77" not found'), /找不到该会话/, 'not found 应中文化');
assert.match(humanizeError(new Error('Session not found')), /找不到该会话/, 'Error 对象的 message 也应中文化');
assert.match(humanizeError('cannot get property "sessionController" without inject'), /服务未就绪/, 'inject 错误应中文化');
assert.ok(/[\u4e00-\u9fa5]/.test(humanizeError('something timed out')), '超时错误应中文化');
assert.equal(humanizeError('列举会话失败：already chinese'), '列举会话失败：already chinese', '已含中文的错误原样保留');
ok('humanizeError：底层英文错误（not found/inject/timeout）中文化，已含中文原样保留');

const binds = ['3f2a-9bcc-11dd'];
const useParsed = parseInbound('/use 3f2a-9bcc-11dd', { explicitSessions: binds });
assert.equal(useParsed.kind, 'use');
assert.equal(useParsed.sessionId, '3f2a-9bcc-11dd');
// 按标题绑定：中文「绑定 <标题>」与含中文/空格/· 的 /use <标题> → use-title
const titleParsed = parseInbound('绑定 微信·甜屿林风', { explicitSessions: binds });
assert.equal(titleParsed.kind, 'use-title', '中文绑定应解析为 use-title');
assert.equal(titleParsed.title, '微信·甜屿林风');
const titleParsed2 = parseInbound('/use 微信 · 甜屿林风', { explicitSessions: binds });
assert.equal(titleParsed2.kind, 'use-title', '含空格与·的 /use 应解析为 use-title');
assert.equal(titleParsed2.title, '微信 · 甜屿林风');
assert.equal(parseInbound('bind Some Title', { explicitSessions: binds }).kind, 'use-title', '英文 bind 别名应解析为 use-title');
assert.equal(parseInbound('/release', { explicitSessions: binds }).kind, 'release');
assert.equal(parseInbound('/list', { explicitSessions: binds }).kind, 'list');
assert.equal(parseInbound('?', { explicitSessions: binds }).kind, 'help');
assert.equal(parseInbound('3f2a=1', { explicitSessions: binds }).outcome, 'allowed-once');
assert.equal(parseInbound('3f2a=0', { explicitSessions: binds }).outcome, 'rejected');
assert.equal(parseInbound('3f2a c', { explicitSessions: binds }).outcome, 'cancelled');
assert.equal(parseInbound('3f2a=也许', { explicitSessions: binds }).kind, 'bad-decision');
assert.equal(parseInbound('zzzz=1', { explicitSessions: binds }).kind, 'unknown-prefix');
assert.equal(parseInbound('今天天气不错', { explicitSessions: binds }).kind, 'passthrough');
// 选择题回复：<前缀> 1A 2B（数字+字母），须在决策之前被识别；未绑定前缀不 claim。
const qrParsed = parseInbound('3f2a 1A 2BC', { explicitSessions: binds });
assert.equal(qrParsed.kind, 'question-reply', '数字+字母应解析为选择题回复');
assert.equal(qrParsed.prefix, '3f2a');
assert.deepEqual(qrParsed.tokens, [{ index: 1, letters: 'A' }, { index: 2, letters: 'BC' }], '应支持多选字母');
assert.equal(parseInbound('3f2a=1', { explicitSessions: binds }).kind, 'decision', '纯 =1 仍是审批决策');
assert.equal(parseInbound('zzzz 1A', { explicitSessions: binds }).kind, 'passthrough', '未绑定前缀的选择回复不 claim，交回聊天');
// v2.1.0：/new [标题] 薄创建会话；空标题 → title:'' 由宿主兜底固定标题。
const newParsed = parseInbound('/new', { explicitSessions: binds });
assert.equal(newParsed.kind, 'new', '/new 应解析为 thin-create 指令');
assert.equal(newParsed.title, '');
const newTitled = parseInbound('/new 我的微信会话', { explicitSessions: binds });
assert.equal(newTitled.kind, 'new');
assert.equal(newTitled.title, '我的微信会话', '/new <标题> 应带上标题');
ok('parseInbound：/use|/release|/list|/help|前缀决策|选择题回复|/new|未知前缀|透传');

// ApprovalRegistry：幂等 settle + 前缀寻址 + permissionPreset 降级 + 提醒上限
const outcomes = [];
const reg = new ApprovalRegistry({ prefixLength: 6, permissionPreset: 'ask', log: () => {} });
reg.register({ id: 'r1', sessionId: '3f2a-9bcc-11dd', chatId: 'c', meta: { toolName: 'run' }, timeoutMs: 0, onSettle: (o) => outcomes.push(o) });
assert.equal(reg.size(), 1);
assert.equal(reg.resolveByPrefix('3f2a', 'allowed-once'), true, '按前缀应能结算');
assert.equal(reg.resolveByPrefix('3f2a', 'rejected'), false, '重复结算应无效（幂等）');
assert.deepEqual(outcomes, ['allowed-once']);
ok('ApprovalRegistry：按会话前缀结算 + 幂等 settle');

const reg2 = new ApprovalRegistry({ prefixLength: 6, permissionPreset: 'allow-once', log: () => {} });
let f2; reg2.register({ id: 'r2', sessionId: 'aaaa-bbbb', timeoutMs: 15, onSettle: (o) => { f2 = o; } });
await new Promise((r) => setTimeout(r, 40));
assert.equal(f2, 'allowed-once', '超时应按 permissionPreset=allow-once 自动批准');
reg2.dispose();
ok('ApprovalRegistry：超时按 permissionPreset 自动降级');

const reg3 = new ApprovalRegistry({ prefixLength: 6, permissionPreset: 'ask', remindIntervalMs: 10, maxReminders: 2, log: () => {} });
let remindN = 0, f3;
reg3.onRemind = () => { remindN++; };
reg3.register({ id: 'r3', sessionId: 'cccc-dddd', timeoutMs: 0, onSettle: (o) => { f3 = o; } });
await new Promise((r) => setTimeout(r, 45));
assert.ok(remindN >= 1 && remindN <= 2, '提醒次数不应超过 maxReminders');
assert.equal(f3, 'cancelled', '提醒耗尽后应按 ask→cancelled 自动结算');
reg3.dispose();
ok('ApprovalRegistry：延迟提醒上限 + 耗尽后自动降级');

// 对话入站：passthrough 文本投给 /use 绑定的会话（submitPrompt 注入）
{
  const sent = [];
  const prompts = [];
  const dlg = createBridge({
    config: { prefixLength: 6 },
    send: async (t) => { sent.push(t); },
    log: () => {},
    submitPrompt: async (sid, text) => { prompts.push({ sid, text }); return { accepted: true }; },
  });
  // 未绑定时给提示、不调用 prompt
  const before = await dlg.handleInbound('普通聊天');
  assert.equal(before.action, 'no-session', '未绑定时不应转交');
  assert.equal(prompts.length, 0);
  assert.ok(sent.some((t) => t.includes('/use')), '未绑定应提示先 /use');
  // /use 绑定后，普通文本转交
  await dlg.handleInbound('/use session-abc123-def');
  sent.length = 0;
  const r = await dlg.handleInbound('在帮你情况下，还能多会话提醒吗？');
  assert.equal(r.action, 'prompt', '绑定后应转交 prompt');
  assert.equal(r.sessionId, 'session-abc123-def');
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0], { sid: 'session-abc123-def', text: '在帮你情况下，还能多会话提醒吗？' });
  assert.equal(sent.length, 0, '转交后不应再发「等待回复」中间回执（正文镜像即反馈）');
  dlg.dispose();
  ok('对话入站：passthrough 文本投给 /use 绑定会话 + 未绑定提示');
}

// 绑定状态持久化：注入 bindingStore 后，启动 load 恢复、bind/release 时 save
{
  const disk = { sessions: ['session-restore-a', 'session-restore-b'], activeSession: 'session-restore-b' };
  const store = {
    load: () => ({ ...disk, sessions: [...disk.sessions] }),
    save: (data) => { disk.sessions = [...data.sessions]; disk.activeSession = data.activeSession; },
  };
  const b = createBridge({
    config: { prefixLength: 6 },
    bindingStore: store,
    send: async () => {},
    log: () => {},
  });
  // 启动恢复：集合 + 活跃会话都在，boundList 立即有值
  assert.deepEqual(b.boundList().sort(), ['session-restore-a', 'session-restore-b']);
  // 新增绑定应写回 store（含新的 activeSession）
  b.bindSession('session-new-c');
  assert.ok(disk.sessions.includes('session-new-c'), 'bind 后应持久化新会话');
  assert.equal(disk.activeSession, 'session-new-c', 'bind 后应持久化活跃会话');
  // releaseAll 应清空并写回
  b.releaseAll();
  assert.deepEqual(disk.sessions, [], 'release 后应持久化空集合');
  assert.equal(disk.activeSession, null, 'release 后应清空活跃会话');
  b.dispose();
  // 不一致的持久化数据：activeSession 不在集合里 → 恢复为 null，不产生幽灵对话目标
  const disk2 = { sessions: ['session-x'], activeSession: 'session-ghost' };
  const store2 = { load: () => ({ ...disk2 }), save: () => {} };
  const prompts2 = [];
  const b2 = createBridge({
    config: { prefixLength: 6 },
    bindingStore: store2,
    send: async () => {},
    log: () => {},
    submitPrompt: async (sid, text) => { prompts2.push({ sid, text }); return { accepted: true }; },
  });
  assert.deepEqual(b2.boundList(), ['session-x']);
  const r = await b2.handleInbound('普通聊天');
  assert.equal(r.action, 'no-session', '幽灵活跃会话应被清空，提示先绑定');
  assert.equal(prompts2.length, 0, '幽灵活跃会话不应触发 prompt');
  b2.dispose();
  ok('绑定状态持久化：启动恢复 + bind/release 写回 + 幽灵活跃会话防护');
}

// 按标题绑定：resolveSessionByTitle 注入后，「绑定 <标题>」反查并绑定；多匹配/未找到/不可用分支
{
  const sent = [];
  const mk = (resolver) => createBridge({
    config: { prefixLength: 6 },
    send: async (t) => { sent.push(t); },
    log: () => {},
    resolveSessionByTitle: resolver,
  });
  // 唯一命中 → 绑定成功
  sent.length = 0;
  let seenTitle = '';
  const b1 = mk(async (t) => { seenTitle = t; return { ok: true, sessionId: 'session-titled-001', title: t }; });
  const r1 = await b1.handleInbound('绑定 微信·甜屿林风');
  assert.equal(r1.action, 'use-title');
  assert.equal(r1.sessionId, 'session-titled-001');
  assert.equal(seenTitle, '微信·甜屿林风', '应把标题原文交给解析器');
  assert.ok(sent.some((t) => t.includes('微信·甜屿林风') && t.includes('已按标题')), '回执应含标题与绑定成功');
  assert.ok(b1.boundList().includes('session-titled-001'), '绑定后会话应进 boundList');
  b1.dispose();
  // 多匹配 → 不绑定，列出候选
  sent.length = 0;
  const b2 = mk(async () => ({ ok: false, matches: [
    { sessionId: 'session-A', title: '微信·甜屿林风' },
    { sessionId: 'session-B', title: '微信·甜屿林风·2' },
  ] }));
  const r2 = await b2.handleInbound('绑定 微信');
  assert.equal(r2.action, 'use-title-ambiguous');
  assert.equal(b2.boundList().length, 0, '多匹配不应绑定');
  assert.ok(sent.some((t) => t.includes('多个会话')), '应提示多个匹配');
  b2.dispose();
  // 未找到 → 不绑定
  sent.length = 0;
  const b3 = mk(async () => ({ ok: false, error: '未找到匹配标题' }));
  const r3 = await b3.handleInbound('绑定 不存在');
  assert.equal(r3.action, 'use-title-notfound');
  assert.equal(b3.boundList().length, 0);
  assert.ok(sent.some((t) => t.includes('未找到')), '应提示未找到');
  b3.dispose();
  // 解析器不可用 → 提示改用全 ID
  sent.length = 0;
  const b4 = createBridge({ config: { prefixLength: 6 }, send: async (t) => { sent.push(t); }, log: () => {} });
  const r4 = await b4.handleInbound('绑定 微信·甜屿林风');
  assert.equal(r4.action, 'use-title-unavailable');
  assert.ok(sent.some((t) => t.includes('不可用')), '应提示按标题绑定不可用');
  b4.dispose();
  ok('按标题绑定：唯一命中绑定/多匹配候选/未找到/不可用四分支');
}

// 卡片指令 /use <前缀>：resolveSessionByPrefix 注入后反查成完整 sessionId 再绑定
{
  const sent = [];
  const mk = (resolver) => createBridge({
    config: { prefixLength: 6 },
    send: async (t) => { sent.push(t); },
    log: () => {},
    resolveSessionByPrefix: resolver,
  });
  // 唯一命中 → 反查绑定完整 ID
  sent.length = 0;
  let seenPrefix = '';
  const b1 = mk(async (p) => {
    seenPrefix = p;
    return { ok: true, sessionId: 'session-91b2175-db79-4ec0' };
  });
  const r1 = await b1.handleInbound('/use 91b217');
  assert.equal(r1.action, 'use');
  assert.equal(r1.sessionId, 'session-91b2175-db79-4ec0', '前缀应反查为完整 sessionId');
  assert.equal(seenPrefix, '91b217', '应把前缀原文交给解析器');
  assert.ok(b1.boundList().includes('session-91b2175-db79-4ec0'), '反查后完整 ID 应进 boundList');
  assert.ok(sent.some((t) => t.includes('按前缀匹配')), '回执应标注按前缀匹配');
  b1.dispose();
  // 反查不到 → 回退字面绑定（保持完整 ID 兼容）
  sent.length = 0;
  const b2 = mk(async () => ({ ok: false, error: '未找到匹配前缀' }));
  const r2 = await b2.handleInbound('/use 3f2a9b');
  assert.equal(r2.action, 'use');
  assert.equal(r2.sessionId, '3f2a9b', '反查失败应回退字面绑定');
  b2.dispose();
  ok('卡片 /use <前缀>：反查绑定完整 ID + 失败回退字面（完整 ID 兼容）');
}

// v2.1.0：/new 薄创建会话 —— createSession 注入后创建 + 立即绑定；默认标题兜底。
{
  const sent = [];
  let seenTitle = '';
  const b = createBridge({
    config: { prefixLength: 6, newSessionTitle: '微信 · Clawbot' },
    send: async (t) => { sent.push(t); },
    log: () => {},
    createSession: async (title) => {
      seenTitle = title;
      return { ok: true, sessionId: 'session-new-aaa111', title };
    },
  });
  // 空标题 → 用配置里的默认标题
  const r1 = await b.handleInbound('/new');
  assert.equal(r1.action, 'new');
  assert.equal(r1.sessionId, 'session-new-aaa111');
  assert.equal(seenTitle, '微信 · Clawbot', '空标题应兜底为默认标题');
  assert.ok(b.boundList().includes('session-new-aaa111'), '新建会话应立即绑定');
  assert.ok(sent.some((t) => t.includes('已新建会话') && t.includes('session-new-aaa111')), '应有新建并绑定回执');
  // 自定义标题
  const r2 = await b.handleInbound('/new 我的会话');
  assert.equal(r2.action, 'new');
  assert.equal(seenTitle, '我的会话', '/new <标题> 应透传自定义标题给 createSession');
  b.dispose();
  // 未注入 createSession → new-unavailable
  const b2 = createBridge({ config: {}, send: async () => {}, log: () => {} });
  const r3 = await b2.handleInbound('/new');
  assert.equal(r3.action, 'new-unavailable', '无 createSession 时应优雅降级');
  b2.dispose();
  ok('/new 薄创建：默认标题兜底 + 自定义标题 + 立即绑定 + 无解析器降级');
}

// v2.1.0：settings-store 工作目录持久化（零依赖、坏文件降级）
{
  const f = '__dsh_ws_settings__.json';
  const store = createSettingsStore(f);
  await writeFile(f, JSON.stringify({ newSessionCwd: 'D:\\ws\\wechat' }), 'utf8');
  assert.equal(store.load().newSessionCwd, 'D:\\ws\\wechat', '应读回工作目录');
  store.save({ newSessionCwd: 'F:\\workspace\\new' });
  assert.equal(store.load().newSessionCwd, 'F:\\workspace\\new', '保存后应可读回');
  await writeFile(f, '{bad json', 'utf8');
  assert.equal(store.load().newSessionCwd, '', '坏文件应静默降级为空');
  await unlink(f).catch(() => {});
  ok('settings-store：工作目录读写 + 坏文件降级');
}

// 选择题（ask_user_question）：user-questions/request waterfall 应答者 + 微信卡 + token 回填
{
  const sent = [];
  const qb = createBridge({ config: { prefixLength: 6, questionTimeoutMs: 0 }, send: async (t) => { sent.push(t); }, log: () => {} });
  const agent = { session: { id: 'session-91b2175-db79-4ec0' } };
  const questions = [
    { id: 'q1', question: '恢复范围？', options: [{ label: '只恢复微信图标' }, { label: '恢复全渠道图标' }, { label: '暂不' }] },
    { id: 'q2', question: '标题来源？', multiSelect: true, options: [{ label: '保持现状' }, { label: '自动加前缀' }, { label: '其他' }] },
  ];
  // 未绑定会话也能回填（m04261 核心回归）：client 富格式卡对所有会话发，
  // 即使该会话从未 /use 绑定，微信回「前缀 1A 2B」也必须命中待决池而非误投自由对话。
  sent.length = 0;
  const unboundPromise = qb.onUserQuestions({ agent, questions, wait: { callId: 'cq0' } });
  const r0 = await qb.handleInbound('91b217 1A 2B');
  assert.equal(r0.action, 'question-reply', '未绑定会话的前缀也应被识别为选择题回填');
  assert.equal(r0.ok, true, '未绑定会话应能结算待决选择题');
  const unboundAnswer = await unboundPromise;
  assert.deepEqual(unboundAnswer.answers, [
    { id: 'q1', selected: ['只恢复微信图标'] },
    { id: 'q2', selected: ['自动加前缀'] },
  ], '未绑定会话回填应按题 id + 选项 label 精确映射（1A=只恢复微信图标，2B=自动加前缀）');
  // 绑定后发起请求：停发即时短卡，返回 Promise（回调返回即回填）
  await qb.handleInbound('/use session-91b2175-db79-4ec0');
  sent.length = 0;
  const answerPromise = qb.onUserQuestions({ agent, questions, wait: { callId: 'cq1' } });
  assert.equal(sent.length, 0, '停发即时选择短卡：host 只保留待决注册，[需要选择] 卡由 client 富格式卡承担');
  // 微信回复 91b217 1A 2BC → 按 label 精确回填
  const r = await qb.handleInbound('91b217 1A 2BC');
  assert.equal(r.action, 'question-reply');
  assert.equal(r.ok, true, '应结算待决选择题');
  const answer = await answerPromise;
  assert.deepEqual(answer.answers, [
    { id: 'q1', selected: ['只恢复微信图标'] },
    { id: 'q2', selected: ['自动加前缀', '其他'] },
  ], '应按题 id + 选项 label 回填（A=第1项/B=第2项/C=第3项，支持多选）');
  // 带 intent 的题是审批语义，不 claim（无 next 时返回 undefined）
  const intentAns = await qb.onUserQuestions({ agent, questions: [{ id: 'q3', question: '批准?', intent: { kind: 'approval', approve: 'y', reject: 'n' } }] });
  assert.equal(intentAns, undefined, '带 intent 的题应交回 approval 链路');
  qb.dispose();
  ok('选择题：任意会话（含未绑定）回填 + 字母→label + 多选 + intent 跳过');
}

// m01709：微信回填胜出后调官方 userQuestions.answer() 让投影 settle 原生卡（替代非官方 dismiss 轮询）。
{
  const sent = [];
  const answerCalls = [];
  const qb = createBridge({
    config: { prefixLength: 6, questionTimeoutMs: 0 },
    send: async (t) => { sent.push(t); },
    log: () => {},
    answerUserQuestion: async (agent, callId, answer) => { answerCalls.push({ agent, callId, answer }); return true; },
  });
  const agent = { session: { id: 'session-3f2a11-db79-4ec0' } }; // 前缀 3f2a11
  const questions = [{ id: 'q1', question: '方向?', options: [{ label: '甲' }, { label: '乙' }] }];
  const answerPromise = qb.onUserQuestions({ agent, questions, wait: { callId: 'call-settled-1' } });
  const r = await qb.handleInbound('3f2a11 1B');
  assert.equal(r.ok, true, '回填应结算成功');
  await answerPromise;
  await new Promise((r2) => setTimeout(r2, 0)); // 等官方 answer 的异步调用跑完
  assert.equal(answerCalls.length, 1, '回填胜出后应调一次官方 answer');
  assert.equal(answerCalls[0].callId, 'call-settled-1', '应传正确的 callId');
  assert.equal(answerCalls[0].agent, agent, '应传正确的 agent');
  assert.deepEqual(answerCalls[0].answer.answers[0].selected, ['乙'], '应传正确答案（1B→乙）');
  qb.dispose();
  ok('m01709：微信回填胜出后调官方 userQuestions.answer() settle 原生卡');
}

// m02017：选择题定期提醒——每 60s（测试用 20ms）发一条带选项+回填码的提醒，最多 3 次，
// 到顶只停提醒不自动跳过；微信回填结算后立即停提醒。
{
  const sent = [];
  const qb = createBridge({
    config: { prefixLength: 6, questionRemindIntervalMs: 20, questionMaxReminders: 3, questionTimeoutMs: 0 },
    send: async (t) => { sent.push(t); },
    log: () => {},
    answerUserQuestion: async () => true,
  });
  const agent = { session: { id: 'session-3f2a11-db79-4ec0' } }; // 前缀 3f2a11
  const questions = [{ id: 'q1', question: '方向?', options: [{ label: '甲' }, { label: '乙' }] }];
  // 不传 next → 独占，无原生 UI 竞答干扰；题保持未结算。
  qb.onUserQuestions({ agent, questions, wait: { callId: 'call-remind-1' } });
  await new Promise((r) => setTimeout(r, 150)); // 20ms × 3 次提醒全部发完并停止
  const reminds = sent.filter((t) => t.includes('[提醒]') && t.includes('选择题仍待选择'));
  assert.equal(reminds.length, 3, '最多发 3 次提醒，到顶停止（不自动跳过）');
  assert.ok(reminds[0].includes('A.甲') && reminds[0].includes('B.乙'), '提醒应带选项');
  assert.ok(reminds[0].includes('3f2a11 1A'), '提醒应带回填码前缀');
  qb.dispose();
  ok('m02017：选择题每 1 分钟提醒一次（带选项+回填码）、最多 3 次、到顶不自动跳过');
}
// m02017：微信回填结算后立即停提醒（已作答不再提醒）。
{
  const sent = [];
  const qb = createBridge({
    config: { prefixLength: 6, questionRemindIntervalMs: 20, questionMaxReminders: 3, questionTimeoutMs: 0 },
    send: async (t) => { sent.push(t); },
    log: () => {},
    answerUserQuestion: async () => true,
  });
  const agent = { session: { id: 'session-3f2a11-db79-4ec0' } };
  const questions = [{ id: 'q1', question: '方向?', options: [{ label: '甲' }, { label: '乙' }] }];
  qb.onUserQuestions({ agent, questions, wait: { callId: 'call-remind-2' } });
  const r = await qb.handleInbound('3f2a11 1A'); // 立即回填结算
  assert.equal(r.ok, true, '回填应成功');
  sent.length = 0;
  await new Promise((r2) => setTimeout(r2, 80)); // 等超过 3 个提醒周期
  const remindsAfter = sent.filter((t) => t.includes('[提醒]'));
  assert.equal(remindsAfter.length, 0, '结算后不应再发提醒');
  qb.dispose();
  ok('m02017：微信回填结算后立即停提醒，不再骚扰用户');
}

// m00006 回归：形似回填码但无待决池/无匹配会话时，绝不误投 activeSession。
// 用户核心抱怨：微信回「前缀 1A」被当成聊天投给最近 /use 绑定的会话。
{
  const sent = [];
  const prompts = [];
  const gb = createBridge({
    config: { prefixLength: 6 },
    send: async (t) => { sent.push(t); },
    log: () => {},
    submitPrompt: async (sid, text) => { prompts.push({ sid, text }); return { accepted: true }; },
    // 模拟宿主按前缀反查全会话：589a9e 无匹配（正是用户截图里那张卡的会话）
    resolveSessionByPrefix: async (prefix) => ({ ok: false, error: '未找到匹配前缀' }),
  });
  await gb.handleInbound('/use session-ea2e2ba9-9ec0-4795-979d-38c424502c17'); // 绑定一个无关会话
  sent.length = 0;
  // 微信回填码但无待决题：必须明确提示「未当作聊天转交」，且 submitPrompt 零调用
  const r = await gb.handleInbound('589a9e 1A');
  assert.equal(r.action, 'question-reply-stale', '无待决题的回填码应走 stale 分支而非 prompt');
  assert.equal(prompts.length, 0, '回填码绝不能误投给已绑定会话（m00006 核心）');
  assert.ok(sent.some((t) => t.includes('没有待决选择题') && t.includes('未当作聊天转交')), '应明确提示未转交');
  gb.dispose();
  ok('回归【m00006】：回填码无待决池时明确提示、绝不误投 activeSession');
}

// m00006 根治：waterfall 链式 next 下，native UI 应答器 pending 不调 next 会饿死
// 排在链尾的监听器。本插件必须 prepend 抢占链首，回调才会执行、待决题才会注册。
{
  const idxSrc = await readText('lib/index.js');
  assert.match(idxSrc, /ctx\.on\('user-questions\/request',[\s\S]{0,120}?bridge\.onUserQuestions\(request, next\),\s*true\)/,
    'user-questions 应答者必须 prepend（第三参 true）抢占 waterfall 链首，避免被 native UI pending 饿死');
  assert.match(idxSrc, /ctx\.on\('approval\/request',[\s\S]{0,120}?bridge\.onApprovalRequest\(request, next\),\s*true\)/,
    'approval 应答者同样应 prepend，避免同类饿死');
  ok('回归【m00006·根治】：两个 waterfall 应答者均 prepend 抢占链首');
}

// m00006 行为级：未绑定会话发起选择题，native UI 应答器（next）永远 pending，
// 微信回填仍必须结算成功且 answer 胜出（prepend + race 语义）。
{
  const sent = [];
  const qb2 = createBridge({ config: { prefixLength: 6, questionTimeoutMs: 0 }, send: async (t) => { sent.push(t); }, log: () => {} });
  const agent = { session: { id: 'session-589a9e11-2222-3333-4444-555566667777' } }; // 前缀 589a9e
  const questions = [{ id: 'q1', question: '如何处理？', options: [{ label: '选项甲' }, { label: '选项乙' }] }];
  // next() 返回一个永远 pending 的 Promise，模拟原生 UI 弹卡等点击（不调 next 下游、不 resolve）。
  const answerPromise = qb2.onUserQuestions({ agent, questions, wait: { callId: 'cq-race' } }, () => new Promise(() => {}));
  const r = await qb2.handleInbound('589a9e 1B');
  assert.equal(r.action, 'question-reply', '回填码应命中选择题分支');
  assert.equal(r.ok, true, 'native UI pending 时微信回填仍应结算');
  const answer = await Promise.race([answerPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('回填未胜出')), 500))]);
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['选项乙'] }], '微信回填应胜出并返回 1B=选项乙');
  qb2.dispose();
  ok('回归【m00006·竞答】：native UI pending 时未绑定会话微信回填仍胜出');
}

// m00497 回归：未绑定会话的插件超时绝不能用空答案抢先 settle（否则 Promise.race
// 判微信胜出→变成「已跳过」，用户随后在 DSH 界面手选没人接收=「手动选择无反应」）。
// 超时只发提示+清待决池，让微信回填失效，最终答案交给原生 UI 的 next() 手选。
{
  const sent = [];
  const qb3 = createBridge({ config: { prefixLength: 6, questionTimeoutMs: 30 }, send: async (t) => { sent.push(t); }, log: () => {} });
  const agent = { session: { id: 'session-97time-1111-2222-3333-444455556666' } };
  const questions = [{ id: 'q1', question: '如何安排？', options: [{ label: '加按钮' }, { label: '先不改' }] }];
  let resolveUi;
  const uiPromise = new Promise((res) => { resolveUi = res; });
  const answerPromise = qb3.onUserQuestions({ agent, questions, wait: { callId: 'cq-timeout' } }, () => uiPromise);
  await new Promise((r) => setTimeout(r, 90)); // 等插件 30ms 超时触发
  assert.ok(sent.some((t) => t.includes('选择题已超时')), '超时提示仍应发出');
  let earlySettled = false;
  answerPromise.then(() => { earlySettled = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(earlySettled, false, '超时后 answerPromise 不得被空答案结算（否则 DSH 手选失效=已跳过）');
  // 用户在 DSH 界面手选，原生 UI 的 next() resolve
  resolveUi({ answers: [{ id: 'q1', selected: ['加按钮'] }] });
  const finalAnswer = await Promise.race([answerPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('手选未胜出')), 500))]);
  assert.deepEqual(finalAnswer.answers, [{ id: 'q1', selected: ['加按钮'] }], '超时后 DSH 手选仍应胜出');
  qb3.dispose();
  ok('回归【m00497】：未绑定会话超时不抢答、DSH 手选仍生效');
}

// 出站流式聚合：agent/assistant-stream 的 text-delta 聚合后在 end 一次性投递微信
{
  const sent = [];
  const stream = createBridge({
    config: { prefixLength: 6 },
    send: async (t) => { sent.push(t); },
    // 正文抬头走标题解析器；未命中时由 bridge 退回短前缀
    sessionTitle: async (sid) => (sid === 'session-stream-xyz' ? '甜屿林风' : ''),
    log: () => {},
  });
  await stream.handleInbound('/use session-stream-xyz');
  sent.length = 0;
  const sid = 'session-stream-xyz';
  // a1 = 最终回复：start → 多个 chunk（正文 + 思考）→ end(committed/assistant/message)
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'start', attemptId: 'a1', revision: 0 } });
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'chunk', attemptId: 'a1', revision: 1, chunk: { type: 'text-delta', text: '你好' } } });
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'chunk', attemptId: 'a1', revision: 2, chunk: { type: 'reasoning-delta', text: '思考中' } } });
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'chunk', attemptId: 'a1', revision: 3, chunk: { type: 'text-delta', text: '，有什么帮忙？' } } });
  assert.equal(sent.length, 0, 'end 之前不应投递，避免逐分片刷屏');
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'end', attemptId: 'a1', revision: 4, outcome: { kind: 'committed', eventType: 'assistant/message' } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1, '最终回复 committed/assistant/message 应一次性投递');
  assert.ok(sent[0].includes('你好，有什么帮忙？'), '应聚合正文且跳过 reasoning');
  assert.ok(!sent[0].includes('思考中'), '不应投递思考过程');
  assert.ok(sent[0].startsWith('DeepSeek Harness · 会话「甜屿林风」'), '正文镜像应以可读标题抬头');
  assert.ok(!sent[0].includes('[stream]'), '正文镜像不应再出现难懂的短码前缀');

  // a2 = 工具循环中的中间播报：committed/assistant/attempt，不得投递
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'start', attemptId: 'a2', revision: 0 } });
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'chunk', attemptId: 'a2', revision: 1, chunk: { type: 'text-delta', text: '我先查一下源码' } } });
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'end', attemptId: 'a2', revision: 2, outcome: { kind: 'committed', eventType: 'assistant/attempt' } } });
  // a3 = 被放弃的 attempt：abandoned，不得投递
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'start', attemptId: 'a3', revision: 0 } });
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'chunk', attemptId: 'a3', revision: 1, chunk: { type: 'text-delta', text: '放弃的内容' } } });
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'end', attemptId: 'a3', revision: 2, outcome: { kind: 'abandoned' } } });
  // a4 = 无 outcome 的 end（旧帧），不得投递
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'start', attemptId: 'a4', revision: 0 } });
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'chunk', attemptId: 'a4', revision: 1, chunk: { type: 'text-delta', text: '无 outcome' } } });
  stream.onAssistantStream({ agent: { session: { id: sid } }, frame: { type: 'end', attemptId: 'a4', revision: 2 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1, 'intermediate/attempt + abandoned + 无 outcome 的 end 一律不投递，微信只留最终回复');

  // onSessionEvent 跳过 assistant/* 正文类事件，避免与流式最终回复重复投递 / 漏出中间播报
  stream.onSessionEvent({ id: sid }, { type: 'assistant/message', data: { message: { content: '最终回复（事件通道）' } } });
  stream.onSessionEvent({ id: sid }, { type: 'assistant/attempt', data: { stream: [] } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1, 'session/event 的 assistant/* 事件应跳过，避免重复/中间播报');

  // 未绑定会话的帧应忽略
  sent.length = 0;
  stream.onAssistantStream({ agent: { session: { id: 'unbound-session' } }, frame: { type: 'chunk', attemptId: 'u1', revision: 1, chunk: { type: 'text-delta', text: 'x' } } });
  stream.onAssistantStream({ agent: { session: { id: 'unbound-session' } }, frame: { type: 'end', attemptId: 'u1', revision: 2, outcome: { kind: 'committed', eventType: 'assistant/message' } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0, '未绑定会话的流式帧应忽略');
  stream.dispose();
  ok('出站流式：仅 committed/assistant/message 投递 + 中间播报/放弃/无 outcome 跳过 + session/event assistant/* 跳过 + 未绑定忽略');
}

// m00564：正文镜像打点与「正文已镜像则吞掉重复 done 卡」的判定依据
{
  const sent = [];
  const dsup = createBridge({
    config: { prefixLength: 6, doneSuppressWindowMs: 60 },
    send: async (t) => { sent.push(t); },
    log: () => {},
  });
  const sidA = 'session-body-mirror-a';
  const sidB = 'session-body-mirror-b';
  // 尚未发正文：两个会话都不应被抑制
  assert.equal(dsup.didRecentlySendBody(sidA), false, '未发过正文的会话不应抑制 done 卡');
  assert.equal(dsup.didRecentlySendBody(sidB), false, '未发过正文的另一会话也不应抑制');
  await dsup.handleInbound('/use ' + sidA);
  // sidA 发一条 committed/assistant/message 正文
  dsup.onAssistantStream({ agent: { session: { id: sidA } }, frame: { type: 'start', attemptId: 'z1', revision: 0 } });
  dsup.onAssistantStream({ agent: { session: { id: sidA } }, frame: { type: 'chunk', attemptId: 'z1', revision: 1, chunk: { type: 'text-delta', text: '任务正文已发' } } });
  dsup.onAssistantStream({ agent: { session: { id: sidA } }, frame: { type: 'end', attemptId: 'z1', revision: 2, outcome: { kind: 'committed', eventType: 'assistant/message' } } });
  assert.equal(dsup.didRecentlySendBody(sidA), true, '刚镜像过正文的会话应抑制其 done 卡（避免重复提醒）');
  assert.equal(dsup.didRecentlySendBody(sidB), false, '正文打点按 sid 隔离，不误伤其它会话');
  assert.equal(dsup.didRecentlySendBody(''), false, '空 sid 不应抑制');
  // 窗口过期后不再抑制
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(dsup.didRecentlySendBody(sidA), false, '超出 doneSuppressWindowMs 后不再抑制');
  dsup.dispose();
  ok('m00564：正文镜像打点抑制重复 done 卡（按 sid 隔离、窗口过期失效）');
}

// ── 2B. Host apply：7 路由 + 官方 seam + 准入裁决 ──
const STATE_MAIN = '__dsh_ws_main_state__.json';
const STATE_IDLE = '__dsh_ws_idle_state__.json';   // 故意不存在 → 未登录
const STATE_LOGIN = '__dsh_ws_login_state__.json';
const BINDING_FILE = '__dsh_ws_bindings__.json';   // 绑定持久化：隔离到临时文件，不污染真实状态
const SETTINGS_FILE = '__dsh_ws_settings_host__.json'; // /new 工作目录持久化：隔离到临时文件
const okFetch = async (url, init) => {
  const u = String(url);
  let body = { ret: 0 };
  if (u.includes('getupdates')) {
    // 长轮询挂起直到 abort（保持 ready 状态且 dispose 后能干净退出）
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }
  if (u.includes('getconfig')) body = { typing_ticket: 'TICKET_SMOKE' };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};
await writeFile(STATE_MAIN, JSON.stringify({
  token: 'TOKEN_SMOKE', botId: 'BOT_SMOKE', baseUrl: '', userId: 'USER_SMOKE',
  getUpdatesBuf: '', typingTicket: '', typingTicketAt: 0,
}));
let rejection = undefined; // undefined = 放行
const allHostCtxs = []; // 收集所有 host ctx，末尾统一 dispose 停掉长轮询
function makeHostCtx(config = {}, opts = {}) {
  const registered = [];
  const events = {};
  const cleanups = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    connection: { requestRejection() { return rejection; } },
    webServer: { register(route) { registered.push(route); return () => {}; } },
    on(name, fn) { events[name] = fn; return () => {}; },
    effect(fn) { cleanups.push(fn); return () => {}; },
  };
  if (typeof opts.decorate === 'function') opts.decorate(ctx);
  host.apply(ctx, { stateFile: opts.stateFile || STATE_MAIN, bindingFile: opts.bindingFile || BINDING_FILE, settingsFile: opts.settingsFile || SETTINGS_FILE, fetchImpl: opts.fetchImpl || okFetch, ...config });
  const wrapped = {
    ctx, registered, events,
    dispose() { for (const c of cleanups) { try { const off = c(); off?.(); } catch { /* ignore */ } } },
  };
  allHostCtxs.push(wrapped);
  return wrapped;
}
const hc = makeHostCtx();
const hcIdle = makeHostCtx({}, { stateFile: STATE_IDLE }); // 故意未登录，用于 502/idle 断言
assert.equal(hc.registered.length, 9, '应注册 9 条 exact 路由（含 SETTINGS_ROUTE + NOTIFY_CLOCK_ROUTE）');
assert.ok(hc.registered.every((r) => r.kind === 'exact' && typeof r.handler === 'function'));
assert.equal(typeof hc.events['session/event'], 'function', '应订阅 session/event');
assert.equal(typeof hc.events['agent/assistant-stream'], 'function', '应订阅 agent/assistant-stream（dsh 0.1.5 起 live 正文走这里）');
assert.equal(typeof hc.events['approval/request'], 'function', '应订阅 approval/request');
assert.equal(typeof hc.events['user-questions/request'], 'function', '应订阅 user-questions/request（选择题）');
ok('apply：9 条 exact 路由 + session/event + agent/assistant-stream + approval/request + user-questions/request 官方 seam');

const route = (p) => hc.registered.find((r) => r.path === p);

function makeRes() {
  return {
    code: 0, headers: null, body: null,
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    end(payload) { this.body = payload; },
  };
}
function makeReq(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req._body = body;
  return req;
}
function invoke(handler, req) {
  const res = makeRes();
  // health 是同步 handler（返回 undefined），wechat 是 async（返回 Promise）。
  // 二者都要等读 body 流结束再断言。
  const ret = handler(req, res);
  const bodyDone = new Promise((resolve) => {
    process.nextTick(() => {
      if (req._body != null) req.emit('data', Buffer.from(req._body));
      req.emit('end');
      resolve();
    });
  });
  const handlerDone = ret && typeof ret.then === 'function' ? ret : Promise.resolve();
  return Promise.all([handlerDone, bodyDone]).then(() => res);
}

// 2a. 准入拒绝 → 403
rejection = 403;
let res = await invoke(route(host.HEALTH_ROUTE).handler, makeReq('GET', null));
assert.equal(res.code, 403);
rejection = undefined;
ok('requestRejection 非 undefined 时拒绝（403）');

// 2b. health 放行 → 200，报 v2 新字段（已登录态 wechatReady: true）
res = await invoke(route(host.HEALTH_ROUTE).handler, makeReq('GET', null));
assert.equal(res.code, 200);
const health = JSON.parse(res.body);
assert.equal(health.name, 'dsh-plugin-wechat-session');
assert.equal(health.version, '2.2.2');
assert.equal(health.wechatReady, true, 'STATE_MAIN 有 token，wechatReady 应为 true');
assert.equal(typeof health.boundSessions, 'number');
assert.equal(health.loginStatus, 'ready');
ok('health 返回 name/version/wechatReady/loginStatus/boundSessions');

// 2c. wechat 非 POST → 405
res = await invoke(route(host.WECHAT_ROUTE).handler, makeReq('GET', null));
assert.equal(res.code, 405);
ok('wechat 路由拒绝非 POST（405）');

// 2d. wechat 空文本 → 400 missing-text
res = await invoke(route(host.WECHAT_ROUTE).handler, makeReq('POST', JSON.stringify({})));
assert.equal(res.code, 400);
assert.equal(JSON.parse(res.body).error, 'missing-text');
ok('wechat 空提醒内容 → 400 missing-text');

// 2e. 未扫码登录时 wechat 投递 → 502（iLink 无 token）
res = await invoke(hcIdle.registered.find((r) => r.path === host.WECHAT_ROUTE).handler,
  makeReq('POST', JSON.stringify({ title: '未登录', desp: 'test' })));
assert.equal(res.code, 502);
assert.match(JSON.parse(res.body).error, /扫码登录/);
ok('未扫码登录时 wechat 投递返回 502');

// 2f. login-status 放行 → 200，已登录态 ready
res = await invoke(route(host.LOGIN_STATUS_ROUTE).handler, makeReq('GET', null));
assert.equal(res.code, 200);
assert.equal(JSON.parse(res.body).status, 'ready');
ok('login-status 返回已登录 ready 状态');

// 2g. 无二维码时 qr.png → 404
res = await invoke(route(host.QR_IMAGE_ROUTE).handler, makeReq('GET', null));
assert.equal(res.code, 404);
ok('无二维码时 qr.png → 404');

// 2h. inbound /use → 显式绑定会话
res = await invoke(route(host.INBOUND_ROUTE).handler, makeReq('POST', JSON.stringify({ text: '/use 3f2a-9bcc-11dd' })));
assert.equal(res.code, 200);
assert.equal(JSON.parse(res.body).action, 'use');
ok('inbound /use 显式绑定会话');

// 2i. sessions 查看已绑定会话与前缀
res = await invoke(route(host.SESSIONS_ROUTE).handler, makeReq('GET', null));
assert.equal(res.code, 200);
const sessions = JSON.parse(res.body);
assert.ok(sessions.bound.some((b) => b.prefix === '3f2a9b'), '应能看到已绑定会话前缀');
ok('sessions 返回已绑定会话及前缀');

// 2j. approval seam：未绑定会话与原生 UI 竞答——next() 先答时透传 UI 决策，不掐断原生界面。
// m04261 核心：未 /use 绑定的会话（如 /new 新建的会话）审批也要能被原生 UI 处理。
const unboundDecided = hc.events['approval/request'](
  { agent: { session: { id: 'zzzz-other' } }, callId: 'call-unbound', toolName: 'run' },
  async () => 'rejected', // 模拟原生 UI 应答器先结算
);
const unboundOutcome = await unboundDecided;
assert.equal(unboundOutcome, 'rejected', '未绑定会话：原生 UI 先答时应透传其决策（不 veto）');
ok('approval/request：未绑定会话与原生 UI 竞答，UI 先答透传');

// 2j2. 核心回归 m04261：未绑定会话的审批卡，微信回「前缀=1」也要精确回填到那个会话，
// 而不是掉进自由对话分支误投给 activeSession。前缀从待决池反查（非绑定集合）。
const otherApprovalPromise = hc.events['approval/request'](
  { agent: { session: { id: '9a3b7c-other-session' } }, callId: 'call-other', toolName: 'Edit' },
  () => new Promise(() => {}), // 原生 UI 仍在等用户点击，不先结算；让微信回填赢
);
res = await invoke(route(host.INBOUND_ROUTE).handler, makeReq('POST', JSON.stringify({ text: '9a3b7c=1' })));
assert.equal(res.code, 200);
const otherDecided = await otherApprovalPromise;
assert.equal(otherDecided, 'allowed-once', '未绑定会话的审批也应能被微信「前缀=1」回填');
ok('approval/request：未绑定会话审批卡可被微信前缀回填（m04261 核心）');

// 2k. approval seam：已绑定会话返回决策 Promise，微信 <前缀>=1 精确批准
const approvalPromise = hc.events['approval/request']({ agent: { session: { id: '3f2a-9bcc-11dd' } }, callId: 'call1', toolName: 'run' });
res = await invoke(route(host.INBOUND_ROUTE).handler, makeReq('POST', JSON.stringify({ text: '3f2a=1' })));
assert.equal(res.code, 200);
const decided = await approvalPromise;
assert.equal(decided, 'allowed-once', '微信回复 3f2a=1 应批准该会话的审批');
ok('approval/request：绑定会话返回 Promise，<前缀>=1 精确批准');

// 2k2. 回归【cordis 严格 inject】：ctx.sessionController 属性访问抛错时，对话入站仍走 ctx.get() 软获取
{
  const prompts = [];
  const hcStrict = makeHostCtx({}, {
    stateFile: STATE_MAIN,
    decorate(cctx) {
      // 模拟 cordis：未 inject 的属性直接抛错；get() 能软取到已注册服务。
      Object.defineProperty(cctx, 'sessionController', {
        configurable: true,
        get() { throw new Error('cannot get property "sessionController" without inject'); },
      });
      cctx.get = (key) => key === 'sessionController'
        ? { prompt: async (req) => { prompts.push(req); return { accepted: true }; } }
        : undefined;
    },
  });
  const inbox = hcStrict.registered.find((r) => r.path === host.INBOUND_ROUTE);
  await invoke(inbox.handler, makeReq('POST', JSON.stringify({ text: '/use session-strict-inject' })));
  const dlgRes = await invoke(inbox.handler, makeReq('POST', JSON.stringify({ text: '严格 inject 下应能转交' })));
  assert.equal(JSON.parse(dlgRes.body).action, 'prompt', '属性访问抛错时仍应通过 ctx.get 转交，不再「转交失败」');
  assert.equal(prompts.length, 1, 'prompt 应被调用一次');
  assert.equal(prompts[0].sessionId, 'session-strict-inject');
  assert.equal(prompts[0].mode, 'queue');
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: '严格 inject 下应能转交' }]);
  ok('回归【cordis 严格 inject】：对话入站走 ctx.get()，不再「转交失败」');
}

// 2k4. 回归【归档会话发消息】：宿主 prompt 不检查归档、会把消息静默入队；
// submitPrompt 必须在投递前查 workspaceRegistry.archivedSessionIds，明确拒绝。
// 真删除的会话 prompt 会抛 session "..." not found，由既有 catch 分支中文化提示。
{
  const archivedSent = [];
  const archivedPrompts = [];
  const archivedFetch = async (url, init) => {
    let body = { ret: 0 };
    if (String(url).includes('getupdates')) {
      return new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
    }
    if (String(url).includes('sendmessage')) {
      try { archivedSent.push(JSON.parse(init.body).msg.item_list[0].text_item.text); } catch { /* ignore */ }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const hcArch = makeHostCtx({}, {
    stateFile: STATE_MAIN,
    fetchImpl: archivedFetch,
    decorate(cctx) {
      cctx.get = (key) => key === 'sessionController'
        ? { prompt: async (req) => { archivedPrompts.push(req); return { accepted: true }; } }
        : key === 'workspaceRegistry'
          ? { archivedSessionIds: new Set(['session-archived-xyz']) }
          : undefined;
    },
  });
  const archInbox = hcArch.registered.find((r) => r.path === host.INBOUND_ROUTE);
  // 绑定一个「已归档」会话，再发普通文本
  await invoke(archInbox.handler, makeReq('POST', JSON.stringify({ text: '/use session-archived-xyz' })));
  archivedSent.length = 0;
  const archRes = await invoke(archInbox.handler, makeReq('POST', JSON.stringify({ text: '归档后发的消息' })));
  assert.equal(archRes.code, 200);
  assert.equal(archivedPrompts.length, 0, '已归档会话不应调用 prompt（否则消息静默入队）');
  assert.ok(archivedSent.some((t) => t.includes('已归档')), '应明确提示会话已归档/已删除');
  assert.ok(archivedSent.some((t) => t.includes('/new')), '归档提示应引导用 /new 创建新会话');
  ok('回归【归档会话发消息】：投递前查 archivedSessionIds，拒绝并提示 /use 与 /new，不再静默入队');
}

// 2k3. 按标题绑定端到端：走 index.js resolveSessionByTitle（sessionController.list + sessionQuery.readTitle）
{
  const prompts = [];
  const hcTitle = makeHostCtx({}, {
    stateFile: STATE_MAIN,
    decorate(cctx) {
      // 严格 inject：属性访问抛错，只经 ctx.get 软取。
      for (const key of ['sessionController', 'sessionQuery']) {
        Object.defineProperty(cctx, key, {
          configurable: true,
          get() { throw new Error(`cannot get property "${key}" without inject`); },
        });
      }
      cctx.get = (key) => {
        if (key === 'sessionController') return {
          list: async () => ({ items: [
            { sessionId: 'session-title-e2e-001' },
            { sessionId: 'session-other' },
          ] }),
          prompt: async (req) => { prompts.push(req); return { accepted: true }; },
        };
        if (key === 'sessionQuery') return {
          readTitle: async (sid) => ({
            title: sid === 'session-title-e2e-001' ? '微信 · 甜屿林风' : '另一个会话',
          }),
        };
        return undefined;
      };
    },
  });
  const inbox = hcTitle.registered.find((r) => r.path === host.INBOUND_ROUTE);
  // 用带空格/·的标题（用户真实输入形态）绑定
  const bindRes = await invoke(inbox.handler, makeReq('POST', JSON.stringify({ text: '绑定 微信 · 甜屿林风' })));
  const bindBody = JSON.parse(bindRes.body);
  assert.equal(bindBody.action, 'use-title', '按标题应解析为 use-title');
  assert.equal(bindBody.sessionId, 'session-title-e2e-001', '应反查到唯一匹配的 sessionId');
  // 绑定后普通文本应转交到该会话
  const dlgRes = await invoke(inbox.handler, makeReq('POST', JSON.stringify({ text: '标题绑定后发消息' })));
  const dlgBody = JSON.parse(dlgRes.body);
  assert.equal(dlgBody.action, 'prompt');
  assert.equal(dlgBody.sessionId, 'session-title-e2e-001');
  assert.equal(prompts.length, 1, 'prompt 应被调用一次');
  assert.equal(prompts[0].sessionId, 'session-title-e2e-001');
  ok('按标题绑定端到端：严格 inject 下 list+readTitle 反查唯一会话并对话');
}

// 2k4. /new 端到端：工作目录→workspaceId 进分组 + 自定义标题加「微信 · 」前缀 + resume→rename + 立即绑定
{
  const WS_SETTINGS_FILE = '__dsh_ws_new_settings_host__.json';
  const calls = [];
  const hcNew = makeHostCtx({}, {
    settingsFile: WS_SETTINGS_FILE,
    decorate(cctx) {
      // 严格 inject：属性访问抛错，只经 ctx.get 软取。
      for (const key of ['sessionController', 'workspaceController']) {
        Object.defineProperty(cctx, key, {
          configurable: true,
          get() { throw new Error(`cannot get property "${key}" without inject`); },
        });
      }
      cctx.get = (key) => {
        if (key === 'workspaceController') return {
          create: async (req) => {
            calls.push({ kind: 'ws-create', path: req.path });
            return { workspace: { workspaceId: 'ws-aaa111', path: req.path }, created: true };
          },
        };
        if (key === 'sessionController') return {
          create: async (req) => {
            calls.push({ kind: 'session-create', req });
            return { sessionId: 'session-new-ac2a3e' };
          },
          resume: async (req) => { calls.push({ kind: 'resume', req }); return {}; },
          rename: async (req) => { calls.push({ kind: 'rename', req }); return { title: req.title, seq: 1 }; },
          prompt: async (req) => { calls.push({ kind: 'prompt', req }); return { accepted: true }; },
          list: async () => ({ items: [{ sessionId: 'session-new-ac2a3e' }] }),
        };
        return undefined;
      };
    },
  });
  // 先经设置路由写入工作目录（即时保存的宿主侧入口）
  const settingsHandler = hcNew.registered.find((r) => r.path === host.SETTINGS_ROUTE);
  assert.ok(settingsHandler, '应注册 SETTINGS_ROUTE');
  const setRes = await invoke(settingsHandler.handler, makeReq('POST', JSON.stringify({ newSessionCwd: 'F:\\ws\\wechat' })));
  assert.equal(setRes.code, 200, 'POST /settings 应成功');
  assert.equal(JSON.parse(setRes.body).newSessionCwd, 'F:\\ws\\wechat', '工作目录应写入');
  // 发 /new 带自定义标题
  const inbox = hcNew.registered.find((r) => r.path === host.INBOUND_ROUTE);
  const newRes = await invoke(inbox.handler, makeReq('POST', JSON.stringify({ text: '/new 甜屿林风1' })));
  const newBody = JSON.parse(newRes.body);
  assert.equal(newBody.action, 'new', '/new 应解析为 new');
  assert.equal(newBody.sessionId, 'session-new-ac2a3e', '应绑定 create 返回的真实 sessionId');
  // 工作区：workspace/create({path}) → create({workspaceId})，不是 cwd
  const wsCreate = calls.find((c) => c.kind === 'ws-create');
  assert.ok(wsCreate && wsCreate.path === 'F:\\ws\\wechat', '应先把工作目录注册为工作区');
  const sessionCreate = calls.find((c) => c.kind === 'session-create');
  assert.deepEqual(sessionCreate.req, { workspaceId: 'ws-aaa111' }, 'create 应收到 workspaceId 而非 cwd（确保进分组）');
  // 命名：resume → rename，标题带「微信 · 」前缀
  const resumeIdx = calls.findIndex((c) => c.kind === 'resume');
  const renameIdx = calls.findIndex((c) => c.kind === 'rename');
  assert.ok(resumeIdx >= 0 && renameIdx > resumeIdx, 'rename 前应先 resume 会话');
  assert.equal(calls[renameIdx].req.title, '微信 · 甜屿林风1', '自定义标题应加「微信 · 」前缀');
  assert.equal(newBody.title, '微信 · 甜屿林风1', '回执应返回带前缀的标题');
  // 立即绑定：boundList 含新会话，之后普通文本投给它
  assert.ok(hcNew.ctx && newBody.sessionId, '会话应立即绑定');
  await unlink(WS_SETTINGS_FILE).catch(() => {});
  ok('/new 端到端：工作目录→workspaceId 进分组 + 标题加「微信 · 」前缀 + resume→rename + 立即绑定');
}

// 2l. 已登录 + iLink mock：wechat 主动投递成功（走 iLink，不涉及 dsh-im）
const DELIVER_STATE = '__dsh_ws_deliver_state__.json';
await writeFile(DELIVER_STATE, JSON.stringify({
  token: 'TOKEN_SMOKE', botId: 'BOT_SMOKE', baseUrl: '', userId: 'USER_SMOKE',
  getUpdatesBuf: '', typingTicket: '', typingTicketAt: 0,
}));
const deliverFetch = async (url, init) => {
  const u = String(url);
  let body = { ret: 0 };
  if (u.includes('getupdates')) body = { ret: -14, errcode: -14 }; // 让收消息循环立即退出，避免空转
  else if (u.includes('getconfig')) body = { typing_ticket: 'TICKET_SMOKE' };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};
const hcDeliver = makeHostCtx({ stateFile: DELIVER_STATE, fetchImpl: deliverFetch });
res = await invoke(hcDeliver.registered.find((r) => r.path === host.WECHAT_ROUTE).handler,
  makeReq('POST', JSON.stringify({ title: 'DSH 需要你看一下', desp: '需要确认权限·会话A' })));
assert.equal(res.code, 200, 'iLink 投递成功应回 200');
assert.equal(JSON.parse(res.body).ok, true);
ok('Host 经 iLink 主动投递成功（title+desp→sendmessage）');

// 2m. 扫码登录：POST /login 取二维码 → qr.png 内嵌 GIF → DELETE /login 取消
const LOGIN_STATE = '__dsh_ws_login_state__.json';
const qrFetch = async (url, init) => {
  const u = String(url);
  let body = { ret: 0 };
  if (u.includes('get_bot_qrcode')) body = { qrcode: 'QR_SMOKE', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/QR_SMOKE?bot_type=3' };
  else if (u.includes('get_qrcode_status')) {
    // 挂起直到 abort（避免 wait 立即 resolve 造成 busy loop；DELETE /login 时收尾）
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};
const hcLogin = makeHostCtx({ stateFile: LOGIN_STATE, fetchImpl: qrFetch });
const loginHandler = hcLogin.registered.find((r) => r.path === host.LOGIN_ROUTE).handler;
res = await invoke(loginHandler, makeReq('POST', null));
assert.equal(res.code, 200);
assert.equal(JSON.parse(res.body).status, 'waiting');
res = await invoke(hcLogin.registered.find((r) => r.path === host.QR_IMAGE_ROUTE).handler, makeReq('GET', null));
assert.equal(res.code, 200, '扫码后 qr.png 应返回内嵌二维码图片');
assert.equal(res.headers['content-type'], 'image/gif', 'qr.png 应为 GIF 图片');
assert.ok(Buffer.isBuffer(res.body) && res.body.slice(0, 4).toString() === 'GIF8', 'qr.png 应为合法 GIF 字节');
res = await invoke(loginHandler, makeReq('DELETE', null)); // 取消后台轮询，避免测试后空转
assert.equal(res.code, 200);
ok('扫码登录：POST 取二维码 → qr.png 内嵌 GIF 图片 → DELETE 取消');

// ───────────────────── 3. Client half ─────────────────────
const clientSrc = await readText('lib/client.js');
const ReactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
};
const store = new Map();
const listeners = {};             // vm 内 uiSession.subscribe 回调写这里
const winListeners = {};          // window 事件回调：type -> [fn]
const docListeners = {};          // document 事件回调：type -> [fn]
// m05207：只留一个弹窗（应用内浮层）。旧断言名 createdNotifications 改为
// 指向浮层数组，让「弹了几张卡」的历史断言继续成立；OS 通知单独计数，应为 0。
const appendedElements = [];      // m05207：唯一的「弹窗」= 应用内浮层卡片
const createdNotifications = appendedElements; // 兼容旧断言名：弹窗计数即浮层数量
const osNotifications = [];       // new Notification 实例（本轮起应为 0）
const fetchCalls = [];            // 所有 sendWechat 的 fetch（不含宿主计时预约）
const notifyClockCalls = [];      // m00713：宿主计时预约/取消请求（独立计数，不干扰 fetchCalls 断言）
const batchTimeouts = [];         // root.setTimeout 的调用（30 秒批次计时）
const clearedTimeouts = [];       // root.clearTimeout 的调用（取消批次）
const miscTimeouts = [];          // 裸 setTimeout（toast 自动关闭等）
const permissionRequests = [];    // m03179：Notification.requestPermission 调用记录
const createdElements = [];       // m04774：document.createElement 产物（应用内浮层）
let timerSeq = 0;

function addListener(bag, type, fn) { (bag[type] || (bag[type] = [])).push(fn); }
function fire(bag, type) { (bag[type] || []).forEach((fn) => { try { fn({}); } catch (e) {} }); }

class FakeNotification {
  constructor(title, opts) { this.title = title; this.opts = opts; this.closed = false; osNotifications.push(this); }
  close() { this.closed = true; }
  static permission = 'granted';
  static requestPermission() {
    permissionRequests.push(FakeNotification.permission);
    FakeNotification.permission = 'granted';
    return Promise.resolve('granted');
  }
}

const fakeWindow = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  console: { log() {}, warn() {}, error() {} },
  location: { origin: 'dsh-app://app' },
  navigator: { userAgent: 'dsh Electron/44.7.0' },
  addEventListener(type, fn) { addListener(winListeners, type, fn); },
  removeEventListener(type, fn) { const a = winListeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
  focus() {},
  setTimeout(fn, ms) { const id = ++timerSeq; batchTimeouts.push({ id, fn, ms }); return id; },
  clearTimeout(id) { clearedTimeouts.push(id); },
  setInterval() { return ++timerSeq; },
  clearInterval() {},
  AudioContext: undefined, webkitAudioContext: undefined,
  __ModuleLoader__: {
    load(entry) { fakeWindow.__entry = entry; },
  },
};
function makeFakeElement() {
  const el = {
    style: {}, className: '', textContent: '', onclick: null, children: [],
    removed: false,
    setAttribute() {}, appendChild(c) { el.children.push(c); }, remove() { el.removed = true; },
  };
  createdElements.push(el);
  return el;
}
const fakeDocument = {
  hidden: true, visibilityState: 'hidden', hasFocus: () => false,
  // m05207：只把「应用内浮层卡片」计入弹窗数组；jumpToSession 创建的
  // Electron iframe 也是 appendChild 产物，但不应算作一次「弹窗」。
  body: { appendChild(el) { if (el.className === 'dsh-pws-inapp-toast') appendedElements.push(el); } },
  createElement() { return makeFakeElement(); },
  addEventListener(type, fn) { addListener(docListeners, type, fn); },
  removeEventListener(type, fn) { const a = docListeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
};
const controlledSetTimeout = (fn, ms) => { const id = ++timerSeq; miscTimeouts.push({ id, fn, ms }); return id; };
const sandbox = {
  window: fakeWindow,
  self: fakeWindow,
  document: fakeDocument,
  Notification: FakeNotification,
  fetch: async (url, opts) => {
    // m00713：宿主计时预约/取消请求独立计数，不干扰 60+ 处 fetchCalls（/wechat）断言。
    if (String(url).includes('/notify-clock')) { notifyClockCalls.push({ url, opts }); return { json: async () => ({ ok: true }) }; }
    fetchCalls.push({ url, opts }); return { json: async () => ({ ok: true }) };
  },
  console: fakeWindow.console,
  Symbol, Object, JSON, Date, Math, Number, String, Array, Promise, URLSearchParams, Buffer,
  setTimeout: controlledSetTimeout, clearTimeout() {}, setInterval: () => ++timerSeq, clearInterval() {},
};
vm.runInNewContext(clientSrc, sandbox, { filename: 'lib/client.js' });
const entry = fakeWindow.__entry;
assert.ok(entry, '应向 __ModuleLoader__ 注册 entry');
assert.equal(entry.id, 'dsh-plugin-wechat-session');
const requireStub = (name) => { if (name === 'react') return ReactStub; throw new Error('unknown module ' + name); };
const mod = entry.factory(requireStub);
// 数组来自 vm 沙箱，原型与主上下文不同，不能用 deepStrictEqual。
assert.equal(Array.from(mod.inject).join(','), 'sessions,locale,slots');
assert.equal(typeof mod.apply, 'function');
ok('lib/client.js 模块包装与 inject/apply 导出');

// ── 会话列表微信图标（纯 DOM 视觉增强，移植自 dsh-im，MIT） ──
assert.equal(typeof mod.parseWechatSessionTitle, 'function', '应导出 parseWechatSessionTitle');
assert.equal(typeof mod.installWechatSessionLogo, 'function', '应导出 installWechatSessionLogo');
assert.ok(clientSrc.includes('Copyright (c) 2026 xmanrui'), '图标移植须保留 MIT 版权声明');
assert.equal(String(mod.parseWechatSessionTitle('微信 · 甜屿林风')), '甜屿林风', '应解析中文微信前缀');
assert.equal(String(mod.parseWechatSessionTitle('WeChat · Foo Bar')), 'Foo Bar', '应解析英文微信前缀');
assert.equal(mod.parseWechatSessionTitle('微信 · '), null, '空标题不应解析');
assert.equal(mod.parseWechatSessionTitle('普通会话标题'), null, '非微信标题不应解析');
assert.equal(mod.parseWechatSessionTitle(null), null, '非字符串不应解析');
// fakeDocument 无 defaultView/MutationObserver/CSS → 安装函数应保底 noop（返回函数、不抛错）
const logoCleanup = mod.installWechatSessionLogo(fakeDocument);
assert.equal(typeof logoCleanup, 'function', '特性检测不满足时应返回清理函数');
assert.doesNotThrow(() => logoCleanup(), 'noop 清理函数不应抛错');
ok('会话列表微信图标：前缀解析 + 特性检测 noop + MIT 声明');

// ── 微信图标真 DOM mock：覆盖「React 增量渲染（childList addedNodes）」路径 ──
// 上一版只有 fakeDocument（无 defaultView/MutationObserver/CSS）→ 整段 noop，
// 77 项全过却没验证真机渲染。这里构造最小可用 DOM，显式触发 addedNodes。
{
  const ROW_SEL = '[role="treeitem"][aria-selected]';
  const MARKED_SEL = '[data-dsh-ws-wxlogo]';
  const TEXT_ATTR = 'data-dsh-ws-wxtext';
  const MARK_ATTR = 'data-dsh-ws-wxlogo';
  function descendants(el) {
    let out = [];
    for (const c of (el.children || [])) { out.push(c); out = out.concat(descendants(c)); }
    return out;
  }
  function qsa(el, sel) {
    const all = descendants(el);
    if (sel === ROW_SEL) return all.filter((n) => n.matches && n.matches(sel));
    if (sel === MARKED_SEL) return all.filter((n) => n.getAttribute && n.getAttribute(MARK_ATTR) !== null);
    return [];
  }
  function makeTitle(text, owner) {
    const attrs = {};
    return {
      tagName: 'SPAN', nodeType: 1, isConnected: true, classList: ['title'], _text: text,
      get textContent() { return this._text; },
      get childNodes() { return this._text ? [{ nodeType: 3 }] : []; },
      get firstChild() { return this._text ? { nodeType: 3 } : null; },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
      setAttribute(k, v) { attrs[k] = String(v); },
      removeAttribute(k) { delete attrs[k]; },
      closest(sel) { return sel === ROW_SEL ? owner : null; },
      matches() { return false; },
      querySelectorAll() { return []; },
    };
  }
  function makeRow(text) {
    const row = {
      tagName: 'DIV', nodeType: 1, isConnected: true, classList: ['sessionRow'], children: [],
      getAttribute(k) { return k === 'role' ? 'treeitem' : (k === 'aria-selected' ? 'false' : null); },
      matches(sel) { return sel === ROW_SEL; },
      closest(sel) { return sel === ROW_SEL ? row : null; },
    };
    const title = makeTitle(text, row);
    row.children.push(title);
    row.querySelectorAll = (sel) => qsa(row, sel);
    return row;
  }
  let observerCb = null;
  let createdStyle = null;
  const domImages = [];
  const domView = {
    CSS: {
      supports(prop, val) {
        if (prop === 'content') {
          if (String(val).indexOf('/ ""') >= 0) return false; // 强制走基础 attr() 降级分支
          return String(val).indexOf('attr(') === 0;
        }
        if (prop === '-webkit-text-fill-color') return val === 'transparent';
        return false;
      },
    },
    Image: function () { const img = {}; domImages.push(img); return img; },
    MutationObserver: function (cb) { observerCb = cb; this.observe = function () {}; this.disconnect = function () {}; },
    // 不设 queueMicrotask → 代码用同步 fallback，便于断言
  };
  const domBody = {
    nodeType: 1, isConnected: true, classList: [], children: [],
    appendChild(el) { this.children.push(el); },
    matches() { return false; },
    closest() { return null; },
    querySelectorAll(sel) { return qsa(this, sel); },
  };
  const domDoc = {
    body: domBody,
    head: { appendChild() {} },
    defaultView: domView,
    createElement(tag) {
      const e = { tagName: String(tag).toUpperCase(), dataset: {}, textContent: '', removed: false, remove() { e.removed = true; } };
      if (String(tag).toLowerCase() === 'style') createdStyle = e;
      return e;
    },
  };
  const domCleanup = mod.installWechatSessionLogo(domDoc);
  assert.equal(typeof domCleanup, 'function', '真实 DOM mock 下应返回清理函数');
  assert.ok(createdStyle, '应注入 <style>');
  assert.ok(createdStyle && createdStyle.textContent.includes('content: attr(' + TEXT_ATTR + ');'), 'CSS 应含基础 attr() 内容（降级分支）');
  assert.ok(createdStyle && !createdStyle.textContent.includes('/ ""'), '不支持新语法时不应输出 `attr() / ""`');
  assert.equal(domImages.length, 1, '应预载一张微信 SVG 图片');
  // 图片加载成功 → ready，初始扫描（body 为空，无行被标记）
  domImages[0].onload();

  // 模拟 React 增量渲染：新会话行以 childList.addedNodes 出现（旧版漏掉此路径）
  const liveRow = makeRow('微信 · 甜屿林风');
  domBody.appendChild(liveRow);
  observerCb([{ type: 'childList', target: domBody, addedNodes: [liveRow], removedNodes: [] }]);
  const liveTitle = liveRow.children[0];
  assert.equal(liveTitle.getAttribute(MARK_ATTR), 'weixin', '增量加入的微信会话行应被标记为微信图标');
  assert.equal(liveTitle.getAttribute(TEXT_ATTR), '甜屿林风', '标记应只保留纯标题文本');

  // 非微信行不应被标记
  const plainRow = makeRow('普通会话');
  domBody.appendChild(plainRow);
  observerCb([{ type: 'childList', target: domBody, addedNodes: [plainRow], removedNodes: [] }]);
  assert.equal(plainRow.children[0].getAttribute(MARK_ATTR), null, '非微信标题不应被标记');

  // dispose 应还原
  domCleanup();
  assert.equal(liveTitle.getAttribute(MARK_ATTR), null, '清理后应移除微信图标标记');
  assert.equal(liveTitle.getAttribute(TEXT_ATTR), null, '清理后应移除纯标题属性');
  ok('微信图标：childList addedNodes 增量渲染 + 降级 CSS + dispose 还原（真 DOM mock）');
}

// apply 之前就塞「陈旧」状态：插件加载那一刻挂着的待办 / 已完成都不该补发提醒。
let fakeUiStatus = new Map([
  ['s0', { running: false, pendingInteraction: { kind: 'approval', key: 'old' }, completionUnread: true }],
]);
// sessions.list 快照：current 指「界面正停在哪条会话」（v1.3.0 会话级判据的数据源）。
let fakeListSnapshot = { current: 'sA', byId: {} };
const listListeners = {};   // vm 内 sessions.list.subscribe 回调写这里
// workspaces.list 快照：archivedSessionIds 是归档会话集（归档/删除静默判据之一）。
let fakeWorkspaceSnapshot = { archivedSessionIds: [] };

const slotsInjected = [];
const registeredSections = [];
const effects = [];
const openSessionCalls = [];   // jumpToSession → ctx.get('uiWorkspace').openSession(sid)
const fakeCtx = {
  get(name) {
    if (name === 'uiSession') return { sessionStatus: fakeStatusStore };
    if (name === 'sessions') return { list: fakeListStore };
    if (name === 'workspaces') return { list: { getSnapshot: () => fakeWorkspaceSnapshot } };
    if (name === 'uiWorkspace') return { openSession: (sid) => { openSessionCalls.push(sid); } };
    return undefined;
  },
  reflect: { get() { return undefined; } },
  locale: {
    register() { return () => {}; },
    bind() { return (k) => k; },
  },
  slots: {
    // 真实宿主会调用工厂 fn() 来产出注册项。
    inject(key, fn) { slotsInjected.push({ key }); const off = fn(); return typeof off === 'function' ? off : () => {}; },
    register(meta, render) { registeredSections.push({ meta, render }); return () => {}; },
  },
  effect(fn, label) { const off = fn(); effects.push({ label, off }); return typeof off === 'function' ? off : () => {}; },
};
const fakeStatusStore = {
  getSnapshot() { return fakeUiStatus; },
  subscribe(cb) { listeners.status = cb; return () => { delete listeners.status; }; },
};
const fakeListStore = {
  getSnapshot() { return fakeListSnapshot; },
  subscribe(cb) { listListeners.list = cb; return () => { delete listListeners.list; }; },
};
mod.apply(fakeCtx);

// ── 事件驱动助手：把宿主快照推进到新状态，并触发对应订阅回调 ──
function pushStatus(map) {
  fakeUiStatus = map;
  if (listeners.status) listeners.status();       // → evalUiStatus() + reapBatch()
}
function setCurrent(sid) {
  fakeListSnapshot = { current: sid, byId: {} };
  if (listListeners.list) listListeners.list();  // → reapBatch()
}
function setAway(away) {
  fakeDocument.hidden = away;
  fakeDocument.visibilityState = away ? 'hidden' : 'visible';
  fakeDocument.hasFocus = () => !away;
}
function noteCount() { return createdNotifications.length; }
function batchTimer() { return batchTimeouts[batchTimeouts.length - 1]; }
assert.ok(slotsInjected.some((s) => s.key === 'settings.section'));
assert.ok(registeredSections.some((s) => s.meta?.id === 'dsh-plugin-wechat-session'));
assert.ok(effects.some((e) => /watchers/.test(e.label)));
ok('apply 挂上 settings.section 槽与 watchers effect');

// 回归：seed 抑制。apply 时 s0 已挂着待办 / 已完成，首次求值只建基线，
// 不该为陈旧状态补发桌面提醒，也不该启动 30 秒批次。
assert.equal(createdNotifications.length, 0, 'seed 阶段不应弹桌面通知');
assert.equal(batchTimeouts.length, 0, 'seed 阶段不应启动 30 秒批次计时');
ok('回归：插件加载时的陈旧交互不补发提醒（seed 只建基线）');

// 设置页渲染工厂无异常（覆盖 makeSettingsView 的整棵 React 树，含 Bot ID / 目标 ID 两个输入框）
const section = registeredSections.find((s) => s.meta?.id === 'dsh-plugin-wechat-session');
assert.ok(section && typeof section.render === 'function');
assert.doesNotThrow(() => section.render());
ok('设置页渲染工厂可执行（Bot ID / 目标 ID 输入，组件身份稳定）');

// 全局控制 API + 配置读写（默认 botId/targetId 为空字符串）
assert.ok(fakeWindow.__dshPluginWechatSession, '应暴露 window.__dshPluginWechatSession');
assert.equal(fakeWindow.__dshPluginWechatSession.config.timeoutSec, 30);
assert.equal(fakeWindow.__dshPluginWechatSession.config.attentionTimeoutSec, 60);
assert.equal(fakeWindow.__dshPluginWechatSession.config.botId, '');
assert.equal(fakeWindow.__dshPluginWechatSession.config.targetId, '');
assert.equal(typeof fakeWindow.__dshPluginWechatSession.testWechat, 'function');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().away, true, 'mock 环境是后台/离开状态');
ok('全局控制 API 与默认配置（任务跑完 30 秒 / 需选择 60 秒 / botId+targetId / 后台判定）');

// 回归【v1.1.1】：老配置里把整段「复制调用参数」JSON 存进了 targetId，
// readConfig() 应自动洗成两个纯 ID（用户不用手动改 localStorage）。
store.set('dshPluginWechatSession.config', JSON.stringify({
  enabled: true,
  botId: 'wx_d0301fd63db4606cc9d5cea',
  targetId: JSON.stringify({ botid: 'wx_d0301fd63db4606cc9d5cea', targetid: 'tgt_4912086eb0a42cb0' }),
  timeoutSec: 30, sound: true, volume: 0.5, wechatEnabled: true, notifyPermission: true,
}));
const washed = fakeWindow.__dshPluginWechatSession.config;
assert.equal(washed.botId, 'wx_d0301fd63db4606cc9d5cea');
assert.equal(washed.targetId, 'tgt_4912086eb0a42cb0', '整段 JSON 应被洗成纯 targetId');
assert.ok(!/[{}"]/.test(washed.targetId), '洗过的 targetId 不能含 JSON 字符');
// 恢复默认空配置，避免影响后续断言。
store.set('dshPluginWechatSession.config', JSON.stringify({
  enabled: true, botId: '', targetId: '', timeoutSec: 30,
  sound: true, volume: 0.5, wechatEnabled: true, notifyPermission: true,
}));
ok('回归：客户端 readConfig() 自动把已存的整段 JSON 洗成两个纯 ID');

// 回归【改名迁移 · 三级回退】：本机改名到 dsh-plugin-wechat-session 后，新 key 还没值时
// 应逐级回退：先读上一版 dshSessionGuardian.config（用户本机现在实际存的就是这个），
// 再读最旧 dshWechatReminder.config。用户已填的 Bot ID / 目标 ID / 超时秒数都不丢。
// api.config 是每次现调 readConfig() 的 getter，能直接验证迁移。
store.delete('dshPluginWechatSession.config');   // 模拟新包刚装好、还没有新 key
store.delete('dshWechatReminder.config');        // 先清掉最旧 key，确保测的是「上一版」中间 key
store.set('dshSessionGuardian.config', JSON.stringify({
  enabled: true,
  botId: 'wx_prev_bot',
  targetId: 'tgt_prev_target',
  timeoutSec: 55, sound: false, volume: 0.7, wechatEnabled: true, notifyPermission: true,
}));
const migratedPrev = fakeWindow.__dshPluginWechatSession.config;
assert.equal(migratedPrev.botId, 'wx_prev_bot', '改名重装后应回退读「上一版」中间 key 的 Bot ID');
assert.equal(migratedPrev.targetId, 'tgt_prev_target', '改名重装后应回退读中间 key 的目标 ID');
assert.equal(migratedPrev.timeoutSec, 55, '中间 key 的其它设置也应一并迁移');
ok('回归【改名迁移】：新 key 为空时回退读上一版中间 key（dshSessionGuardian.config），已填配置不丢');

// 再验证最底一层：中间 key 也没有时才回退到最旧 key。
store.delete('dshSessionGuardian.config');
store.set('dshWechatReminder.config', JSON.stringify({
  enabled: true,
  botId: 'wx_migrated_bot',
  targetId: 'tgt_migrated_target',
  timeoutSec: 45, sound: false, volume: 0.8, wechatEnabled: true, notifyPermission: true,
}));
const migrated = fakeWindow.__dshPluginWechatSession.config;
assert.equal(migrated.botId, 'wx_migrated_bot', '改名重装后应读回最旧 key 的 Bot ID');
assert.equal(migrated.targetId, 'tgt_migrated_target', '改名重装后应读回最旧 key 的目标 ID');
assert.equal(migrated.timeoutSec, 45, '最旧 key 的其它设置也应一并迁移');
ok('回归【改名迁移】：两级旧 key 都空读时回退到最旧 key（dshWechatReminder.config），配置仍不丢');

// 优先级：新 key 有值时覆盖所有旧 key。
store.set('dshPluginWechatSession.config', JSON.stringify({
  enabled: true, botId: 'wx_new_bot', targetId: '', timeoutSec: 30,
  sound: true, volume: 0.5, wechatEnabled: true, notifyPermission: true,
}));
assert.equal(fakeWindow.__dshPluginWechatSession.config.botId, 'wx_new_bot', '新 key 优先于旧 key');
ok('回归【改名迁移】：新 key 有值时优先采用，不被旧 key 覆盖');
// 恢复默认空配置，避免影响后续断言（新 key 优先，旧 key 保留不清）。
store.set('dshPluginWechatSession.config', JSON.stringify({
  enabled: true, botId: '', targetId: '', timeoutSec: 30,
  sound: true, volume: 0.5, wechatEnabled: true, notifyPermission: true,
}));

// ── 回归【v1.3.0 / m01757 核心 bug】──────────────────────────────
// 三条会话并行、界面停在 sA：sB 需要确认权限时，旧实现因为「窗口在前台」
// 用 isAway() 一刀切静音，导致别的会话既不弹通知也不发微信。
// 新规则：前台只静音「正盯着的那条」，其他会话照常提醒 + 30 秒微信兜底。
setAway(false);                          // 窗口在前台、可见、有焦点
setCurrent('sA');                        // 界面停在 sA
assert.equal(fakeWindow.__dshPluginWechatSession.debug().away, false, '模拟窗口在前台');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().currentSid, 'sA', '当前会话应能由 sessions.list 推导');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().sessionsBound, true, 'sessions.list 应已订阅');
ok('会话级判据已接线（currentSid=sA / sessionsBound=true）');

const notesBefore = createdNotifications.length;
const timersBefore = batchTimeouts.length;
pushStatus(new Map([
  ['sA', { running: true }],
  ['sB', { running: true, pendingInteraction: { kind: 'approval', key: 'kB', toolName: 'Bash', reason: '需要运行命令' }, completionUnread: false }],
]));
// v1.5.0：需要确认/选择也弹一张「带具体内容」的系统通知（对齐 dsh-pet 格式），
// 且 30 秒微信兜底批次照常起——提示音与微信都保留。
assert.equal(createdNotifications.length, notesBefore + 1, 'approval/question 应弹一张带内容的系统通知');
const approvalNote = createdNotifications[createdNotifications.length - 1];
assert.match(approvalNote.title, /正在申请权限/, '标题应对齐 dsh-pet 的「正在申请权限」');
assert.match(approvalNote.title, /sB/, '标题应带会话名');
assert.match(approvalNote.opts.body, /Bash/, '正文应显示从 pendingInteraction 抽出的具体工具名');
assert.match(approvalNote.opts.body, /需要运行命令/, '正文应带工具原因');
assert.match(approvalNote.opts.tag, /sB/, 'tag 应带会话 id');
assert.equal(typeof approvalNote.onclick, 'function', '通知应绑定 onclick');
const openBeforeApproval = openSessionCalls.length;
approvalNote.onclick();
assert.equal(openSessionCalls[openSessionCalls.length - 1], 'sB', '点审批通知也应跳到 sB');
assert.equal(approvalNote.closed, true, '点击后审批通知应关闭');
assert.equal(batchTimeouts.length, timersBefore + 1, 'approval/question 仍应起一个微信兜底批次');
// m03992：需选择 / 确认类改用独立的 attentionTimeoutSec（默认 60 秒），
// 任务跑完类才用 timeoutSec（30 秒）。
assert.equal(batchTimer().ms, 60000, '需选择/确认类默认超时是 60 秒（独立秒数）');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, 1, '批次里有 1 条');
ok('回归：前台界面停 sA 时，sB 需要确认 → 弹带内容通知(可点跳会话) + 起 60 秒微信兜底批次');

// 「页面变可见」不该再一刀切取消别的会话的待办（人在窗口前本来就算没响应）。
fire(docListeners, 'visibilitychange');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, 1, '可见性变化不应取消「给别的会话」的批次');
ok('回归：前台可见性事件不再误取消别的会话的微信兜底');

// 超时：人在窗口前、既没切到 sB 也没点掉待办 → 照样发微信（用户决策②）。
const fetchBefore = fetchCalls.length;
batchTimer().fn();
assert.equal(fetchCalls.length, fetchBefore + 1, '前台超时也应发微信');
const sentBody = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
assert.equal(fetchCalls[fetchCalls.length - 1].url, '/__dsh-plugin-wechat-session/wechat');
assert.equal(sentBody.title, '', '功能融合后富格式卡 title 留空（整段作 desp）');
assert.match(sentBody.desp, /【 授予权限 】/, '需确认类富格式卡应带【 授予权限 】状态标签');
assert.match(sentBody.desp, /Bash/, '富格式卡正文应带具体工具名');
assert.match(sentBody.desp, /\/use sb\n\n绑定 sB/, '富格式卡应带 /use <前缀> + 绑定 <标题> 两行');
assert.ok('botId' in sentBody && 'targetId' in sentBody, '转发体应带 botId/targetId');
assert.ok(!('sendKey' in sentBody), '转发体不应再有 sendKey');
ok('回归：前台超时没切过去看/没处理 → 发富格式微信卡（授予权限 + 前缀/标题绑定两行）');

// 回归【用户决策①】：正盯着的 sA 自己需要选择 → 保持安静（不弹、不起批次）。
const notesBefore2 = createdNotifications.length;
const timersBefore2 = batchTimeouts.length;
pushStatus(new Map([
  ['sA', { running: true, pendingInteraction: { kind: 'question', key: 'kA' }, completionUnread: false }],
]));
assert.equal(createdNotifications.length, notesBefore2, '当前会话不应弹通知');
assert.equal(batchTimeouts.length, timersBefore2, '当前会话不应起批次');
assert.ok(!fakeWindow.__dshPluginWechatSession.debug().batch, '批次应为空');
ok('回归：正盯着的那条会话保持安静（不弹/不响/不发微信）');

// 回归【用户决策②】：切到那条会话去看 → 算已响应，取消批次 + 撤通知。
setCurrent('sA');
pushStatus(new Map([
  ['sC', { running: true, pendingInteraction: { kind: 'approval', key: 'kC' }, completionUnread: false }],
]));
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, 1, 'sC 待办开新批次');
const cTimer = batchTimer();
setCurrent('sC');                          // 用户切到 sC 去看
assert.equal(clearedTimeouts.includes(cTimer.id), true, '切过去看应清掉批次计时器');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, null, '切过去看应取消整批');
ok('回归：切到对应会话去看 → 取消微信补发');

// 回归【用户决策②】：把待办处理掉 → 也算已响应，取消批次。
pushStatus(new Map([
  ['sD', { running: true, pendingInteraction: { kind: 'question', key: 'kD' }, completionUnread: false }],
]));
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, 1, 'sD 待办开新批次');
pushStatus(new Map([
  ['sD', { running: true, pendingInteraction: null, completionUnread: false }],
]));
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, null, '待办被点掉应取消批次');
ok('回归：把待办处理掉 → 取消微信补发');

// 回归：窗口整个在后台时，连「当前会话」也提醒，且不会被 curAt 边界误回收。
// v1.5.0：后台 approval 也弹一张带内容的通知，微信兜底批次照常。
setAway(true);
setCurrent('sA');
const notesBefore5 = createdNotifications.length;
pushStatus(new Map([
  ['sA', { running: true, pendingInteraction: { kind: 'approval', key: 'kE', toolName: 'Write', reason: '写文件' }, completionUnread: false }],
]));
assert.equal(createdNotifications.length, notesBefore5 + 1, '后台 approval 也应弹一张带内容的通知');
assert.match(createdNotifications[createdNotifications.length - 1].opts.body, /Write/, '后台通知正文也应带具体内容');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, 1, '后台当前会话的提醒不该在入批同帧被误回收');
ok('回归：整个窗口后台 → 当前会话也提醒（带内容通知+微信批次），curAt 边界不误回收');

// 从后台回到前台：onReturn(true) 把「给当前会话弹的」条目算已看到并回收。
setAway(false);
fire(docListeners, 'visibilitychange'); // visible → onReturn
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, null, '回到前台应回收「给当前会话弹的」提醒');
ok('回归：后台→前台回来 → 回收「给当前会话弹的」提醒');

// ── 回归【v1.5.0】：任务跑完弹一张「对齐 dsh-pet 格式」的通知，点击切到对应会话 ──
setAway(false);
setCurrent('sA');   // 界面停 sA，让 sE 的完成属于「别的会话」
const notesDone0 = createdNotifications.length;
// 先让 sE running，再推到完成（completionUnread 上升沿 → done 边沿）
pushStatus(new Map([
  ['sA', { running: true }],
  ['sE', { running: true, completionUnread: false }],
]));
pushStatus(new Map([
  ['sA', { running: true }],
  ['sE', { running: false, completionUnread: true }],   // sE 这一轮回复结束
]));
assert.equal(createdNotifications.length, notesDone0 + 1, '任务跑完应弹一张系统通知');
const doneNote = createdNotifications[createdNotifications.length - 1];
assert.match(doneNote.title, /对话完成/, '通知标题应对齐 dsh-pet 的「对话完成」');
assert.match(doneNote.title, /sE/, '通知标题应带会话名');
assert.match(doneNote.opts.body, /对话完成|点这条通知|切到该会话/, '取不到具体内容时应回退成中文说明');
assert.match(doneNote.opts.tag, /sE/, 'tag 应带会话 id');
assert.equal(typeof doneNote.onclick, 'function', '通知应绑定 onclick');
const openBefore = openSessionCalls.length;
doneNote.onclick();
assert.equal(openSessionCalls.length, openBefore + 1, '点击通知应调用 uiWorkspace.openSession');
assert.equal(openSessionCalls[openSessionCalls.length - 1], 'sE', '应跳到 sE 这一条会话');
assert.equal(doneNote.closed, true, '点击后通知应关闭');
ok('回归【v1.5.0】：任务跑完弹一张带会话名的通知，点击切到对应会话');

// 回归【v1.5.0】：「需要手动选择」也弹一张带具体问题文本、可点跳会话的通知。
const notesQ0 = createdNotifications.length;
pushStatus(new Map([
  ['sA', { running: true }],
  ['sQ', { running: true, pendingInteraction: { kind: 'question', key: 'kQ', question: '现在调用的大模型是哪个？' }, completionUnread: false }],
]));
assert.equal(createdNotifications.length, notesQ0 + 1, 'question 也应弹一张系统通知');
const qNote = createdNotifications[createdNotifications.length - 1];
assert.match(qNote.title, /模型在等你回答/, 'question 标题应对齐 dsh-pet 的「模型在等你回答」');
assert.match(qNote.title, /sQ/, 'question 标题应带会话名');
assert.match(qNote.opts.body, /现在调用的大模型是哪个/, 'question 正文应显示具体问题文本');
const openBeforeQ = openSessionCalls.length;
qNote.onclick();
assert.equal(openSessionCalls[openSessionCalls.length - 1], 'sQ', '点 question 通知也应跳到 sQ');
ok('回归【v1.5.0】：需要手动选择弹带问题文本的通知，点击切到对应会话');

// 回归【v1.5.0】：测试按钮弹「对话完成」带会话名的卡（不再是空白 attention 卡）。
const notesTest0 = createdNotifications.length;
fakeWindow.__dshPluginWechatSession.testDesktop();
assert.equal(createdNotifications.length, notesTest0 + 1, 'testDesktop 应弹一张卡');
const testNote = createdNotifications[createdNotifications.length - 1];
assert.match(testNote.title, /对话完成/, 'testDesktop 弹的是「对话完成」卡');
assert.match(testNote.title, /sA|当前对话/, 'testDesktop 卡应带当前会话名');
ok('回归【v1.5.0】：testDesktop 弹「对话完成」带会话名的卡（不再是空白 attention 卡）');

// ── 回归【m02943】：后台委托 / 子代理会话一律静默（不弹窗 / 不响铃 / 不发微信）──
// Mnemon「自进化」落盘任务、被 modsearch 调用的后台子代理会创建这类会话，
// 宿主会话列表本就不显示（origin==='subagent'）。修复在 noteAlert() 唯一入口
// 加 isIgnoredSession() 早返回，四类判据都走同一条过滤，一次覆盖三类通道。
// setCurrent() 会清空 byId，这里另写一个助手，让 byId 带上标记行。
function setSessions(current, byId) {
  fakeListSnapshot = { current: current, byId: byId || {} };
  if (listListeners.list) listListeners.list();   // → reapBatch()（batch 为 null 时无副作用）
}
// 把存量批次发掉并清空 batch，让每个场景都从「没有活跃批次」起算，
// 这样「不弹通知 / 不起批次 / 不发微信」都能用增量干净验证。m03992 起
// fireBatchTimeout 只发「已到 deadline 的条目」，未到期的会留在新批次里
// 重排计时器，所以要循环触发直到批次彻底排空。
let drainGuard = 0;
while (fakeWindow.__dshPluginWechatSession.debug().batch && batchTimeouts.length && drainGuard++ < 30) {
  batchTimer().fn();   // 每次把最早那条到期项发掉，剩余项重排
}
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, null, '存量批次应被彻底排空');
setAway(true);         // 后台：无过滤时所有会话都应弹，是最严格的对照组条件

const ignoredCases = [
  { tag: 'origin=subagent（宿主隐藏判据）', row: { origin: 'subagent' } },
  { tag: 'delegationDepth>0（宿主委托判据）', row: { delegationDepth: 1 } },
  { tag: 'parentId（subagentCatalog 投影行）', row: { parentId: 'parent-main' } },
  { tag: 'header.origin=subagent（嵌套 SessionHeader）', row: { header: { origin: 'subagent' } } },
  { tag: 'header.delegationDepth>0（嵌套 SessionHeader）', row: { header: { delegationDepth: 2 } } },
  { tag: '标题前缀 [dsh-mnemon:delegated skill]（截图真实场景）', row: { displayTitle: '[dsh-mnemon:delegated skill] Task: 自进化复盘' } },
  { tag: 'title 前缀 [dsh-mnemon:delegated review]', row: { title: '[dsh-mnemon:delegated review] x' } },
];
for (let ci = 0; ci < ignoredCases.length; ci++) {
  const c = ignoredCases[ci];
  const sid = 'ign-' + ci;
  setSessions('sA', { [sid]: c.row });
  const n0 = createdNotifications.length;
  const t0 = batchTimeouts.length;
  const f0 = fetchCalls.length;
  // ① 需要确认权限：当前实现会弹带内容通知 + 起 30 秒微信兜底批次
  pushStatus(new Map([
    ['sA', { running: true }],
    [sid, { running: true, pendingInteraction: { kind: 'approval', key: 'k-' + sid, toolName: 'Bash' }, completionUnread: false }],
  ]));
  assert.equal(createdNotifications.length, n0, c.tag + '：approval 不应弹桌面通知');
  assert.equal(batchTimeouts.length, t0, c.tag + '：approval 不应起 30 秒批次');
  // ② 任务跑完（completionUnread 上升沿 → done 边沿，最贴近截图里
  //    「任务跑完了·[dsh-mnemon:delegated skill] ...」那条微信汇总行）
  pushStatus(new Map([
    ['sA', { running: true }],
    [sid, { running: false, completionUnread: true }],
  ]));
  assert.equal(createdNotifications.length, n0, c.tag + '：done 不应弹桌面通知');
  assert.equal(batchTimeouts.length, t0, c.tag + '：done 不应起 30 秒批次');
  // 超时点也不该有微信补发：被过滤后既没有批次计时器，也不产生任何 fetch
  assert.equal(fetchCalls.length, f0, c.tag + '：不应产生任何微信补发请求');
}
ok('回归【m02943】：7 类后台委托/子代理会话（含截图真实前缀）approval + done 全部静默（不弹/不响/不发微信）');

// 对照组：普通会话（无任何后台标记）在同样后台条件下仍照常提醒，
// 证明 isIgnoredSession() 没有误伤正常会话、微信兜底主链路仍然完好。
setSessions('sA', { normal: { displayTitle: '正常会话' } });
const nn0 = createdNotifications.length;
const nt0 = batchTimeouts.length;
pushStatus(new Map([
  ['sA', { running: true }],
  ['normal', { running: true, pendingInteraction: { kind: 'approval', key: 'k-normal', toolName: 'Bash' }, completionUnread: false }],
]));
assert.equal(createdNotifications.length, nn0 + 1, '普通会话仍应弹桌面通知');
assert.equal(batchTimeouts.length, nt0 + 1, '普通会话仍应起 30 秒微信兜底批次');
ok('回归【m02943】：普通会话不受影响，仍照常弹窗 + 起微信兜底批次（过滤未误伤）');

// ── 回归【归档/删除会话误弹对话完成】：noteAlert 唯一入口按 sid 过滤 ──
// 真机 bug：归档 / 删除一个会话会同时引发 running 边沿 + completionUnread 上升沿
// （各一次 → 弹窗+微信卡各 2 次）。isArchivedOrDeletedSession 用
// workspaces.list.getSnapshot().archivedSessionIds（归档）+ sessions.list.getSnapshot().ids
// （删除，用 ids 不用 byId）判断，只在信号明确证明时静默。
// 先把存量批次排空，后台条件最严格（无过滤时全部会弹）。
drainGuard = 0;
while (fakeWindow.__dshPluginWechatSession.debug().batch && batchTimeouts.length && drainGuard++ < 30) {
  batchTimer().fn();
}
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, null, '存量批次应被排空');
setAway(true);

// 情形一：已归档会话——archivedSessionIds 含该 sid。
function setWorkspaces(ids) { fakeWorkspaceSnapshot = { archivedSessionIds: ids }; }
function setListIds(ids) { fakeListSnapshot = { current: 'sA', byId: {}, ids: ids }; if (listListeners.list) listListeners.list(); }

setWorkspaces(['arch-sid']);
setListIds(['arch-sid', 'sA']);   // 归档案仍可能在 ids 里（宿主未即时剔除），归档判据优先
{
  const sid = 'arch-sid';
  const n0 = createdNotifications.length, t0 = batchTimeouts.length, f0 = fetchCalls.length;
  // approval 边沿
  pushStatus(new Map([
    ['sA', { running: true }],
    [sid, { running: true, pendingInteraction: { kind: 'approval', key: 'k-' + sid, toolName: 'Bash' }, completionUnread: false }],
  ]));
  // done 边沿（running true→false + completionUnread 上升）
  pushStatus(new Map([
    ['sA', { running: true }],
    [sid, { running: false, completionUnread: true }],
  ]));
  assert.equal(createdNotifications.length, n0, '已归档会话不应弹桌面通知');
  assert.equal(batchTimeouts.length, t0, '已归档会话不应起微信批次');
  assert.equal(fetchCalls.length, f0, '已归档会话不应发微信');
}
ok('回归【归档会话】：archivedSessionIds 命中的会话 approval + done 全部静默');

// 情形二：已删除会话——不在 sessions.list.ids 里（byId 仍保留 fallback 行，不可用 byId 判断）。
setWorkspaces([]);               // 未归档
setListIds(['sA']);              // del-sid 已从 ids 移除，但 byId 里可能还留着
fakeListSnapshot.byId['del-sid'] = { displayTitle: '已删除会话' };
{
  const sid = 'del-sid';
  const n0 = createdNotifications.length, t0 = batchTimeouts.length, f0 = fetchCalls.length;
  pushStatus(new Map([
    ['sA', { running: true }],
    [sid, { running: true, pendingInteraction: { kind: 'approval', key: 'k-' + sid, toolName: 'Bash' }, completionUnread: false }],
  ]));
  pushStatus(new Map([
    ['sA', { running: true }],
    [sid, { running: false, completionUnread: true }],
  ]));
  assert.equal(createdNotifications.length, n0, '已删除会话不应弹桌面通知');
  assert.equal(batchTimeouts.length, t0, '已删除会话不应起微信批次');
  assert.equal(fetchCalls.length, f0, '已删除会话不应发微信');
}
ok('回归【删除会话】：不在 sessions.list.ids 的会话 approval + done 全部静默（用 ids 不用 byId）');

// 复原信号，避免影响后续测试：空归档 + 不设 ids（走原有 byId 逻辑）。
setWorkspaces([]);
fakeListSnapshot = { current: 'sA', byId: {} };
if (listListeners.list) listListeners.list();

// ── 回归【m03179】：桌面弹窗/提示音「后台静默失败」治本修复 ──
// 根因：toast() 把 new Notification 卡在 permission==='granted'，而申请权限只在
// 首次手势做一次；DSH 重开换端口 → 新 origin → 权限回 default，窗口又在后台，
// 于是不弹窗；silent:true 关掉系统音、声音全压在会挂起的 WebAudio 上；外层空
// catch 把一切吞掉。修复对齐 dsh-pet initNotify：启动即申请 + 每次提醒前重试 +
// 打开系统音兜底 + 全程日志 + debug() 暴露两道门槛状态。
// ① 源码级：确认关键修复都还在（防止以后被改回去）。
assert.ok(!/silent:\s*true/.test(clientSrc), 'toast 不应再把通知标成静音（系统通知音要留作兜底）');
assert.ok(/function ensurePermission/.test(clientSrc), '应有可重试的 ensurePermission()');
assert.ok(/function noteLog/.test(clientSrc), '应有日志出口，不能再用空 catch 静默吞失败');
assert.match(clientSrc, /ensurePermission\(\);\s*unlockAudio\(\);\s*bindSessionsList\(\);/,
  '激活时应主动申请权限 + 解锁音频（不依赖用户先点一下窗口）');
assert.match(clientSrc, /function toast[\s\S]{0,400}?ensurePermission\(\)/,
  '每次提醒前都应重试通知权限');
assert.match(clientSrc, /notifyPermission:\s*\(/, 'debug() 应暴露通知权限运行时状态');
assert.match(clientSrc, /audioState:/, 'debug() 应暴露 WebAudio 运行时状态');
ok('回归【m03179】：源码级（去静音/启动即申请/每次提醒重试/日志/debug 诊断字段）齐备');

// ② debug() 新增诊断字段可读。
const dbg = fakeWindow.__dshPluginWechatSession.debug();
assert.equal(dbg.notifyPermission, 'granted', 'debug 应能读出当前通知权限');
assert.equal(dbg.notifySound, true, 'debug 应能读出提示音开关');
assert.equal(typeof dbg.audioState, 'string', 'debug 应能读出音频状态');
assert.equal(typeof dbg.permissionPending, 'boolean', 'debug 应能读出权限申请中标记');
ok('回归【m03179】：debug() 暴露通知权限/音频状态/提示音开关，便于实测核验');

// ③ 行为级：模拟「DSH 重开后权限丢回 default、窗口在后台、用户还没点过窗口」。
// m05207：现在弹窗只剩应用内浮层，与系统权限无关；但 ensurePermission() 仍会
// 在每次提醒前重试申请（音频解锁也靠它），所以仍断言它会重新申请一次。
FakeNotification.permission = 'default';
const reqBefore = permissionRequests.length;
const notesFix0 = appendedElements.length;
const osFix0 = osNotifications.length;
fakeWindow.__dshPluginWechatSession.testDesktop();
assert.equal(permissionRequests.length, reqBefore + 1,
  '权限丢失为 default 时，提醒前应主动重新申请通知权限');
assert.equal(FakeNotification.permission, 'granted', '重新申请后权限应恢复为 granted');
assert.equal(appendedElements.length, notesFix0 + 1,
  '权限丢回 default 也应挂出 1 张应用内浮层（不再静默失败）');
assert.equal(osNotifications.length, osFix0,
  '不应再 new Notification（只留浮层一个弹窗）');
ok('回归【m03179/m05207】：后台 + 权限丢失(default)时仍主动申请权限，且只弹浮层不弹 OS 横幅');

// ── 回归【m04774① / m05207】：应用内浮层是「唯一」的弹窗 ──
// 用户实测：人在别的会话界面 + 系统通知未授权 → 只有提示声、看不到任何弹窗。
// m04774① 加了不依赖系统权限的浮层；m05207 又反馈「浮层 + OS 横幅两张太复杂」，
// 于是去掉 OS 横幅，每次提醒只留这一张浮层 + 提示音。
setAway(true);
FakeNotification.permission = 'denied';          // OS 通知即使彻底不可用也不影响浮层
const appBefore = appendedElements.length;
const osBefore = osNotifications.length;
const jumpsBefore = openSessionCalls.length;
fakeWindow.__dshPluginWechatSession.testDesktop();
assert.equal(osNotifications.length, osBefore,
  '只留一个弹窗：不应再 new Notification（系统横幅已移除）');
assert.equal(appendedElements.length, appBefore + 1,
  '每次提醒只挂出 1 张应用内浮层卡片');
const card = appendedElements[appendedElements.length - 1];
assert.equal(card.className, 'dsh-pws-inapp-toast', '浮层应带可识别的 className');
assert.equal(card.style.right, '16px', '浮层应贴在右下角（right: 16px）');
assert.equal(card.style.bottom, '16px', '浮层应贴在右下角（bottom: 16px）');
assert.ok(!card.style.top, '浮层不应再贴在顶部（已移到右下角）');
assert.ok(card.children.length >= 2, '浮层应含标题与正文/点击提示');
assert.match(card.children[0].textContent, /对话完成/, '浮层标题应写明事件（对话完成）');
card.onclick();                                  // 模拟点击
assert.equal(card.removed, true, '点击后浮层应自行关闭');
assert.equal(openSessionCalls.length, jumpsBefore + 1, '点击浮层应跳到对应会话');
FakeNotification.permission = 'granted';        // 恢复，后续用例照常
ok('回归【m04774①/m05207】：只弹 1 张应用内浮层（右下角、可点跳会话），不再有第二个 OS 横幅');

// ── 回归【m04774③】：真回填交 dsh-im 原生同步提问，图3长文说明卡已删除 ──
// 源码级静态断言：确认「微信里回 1 直接选」的方案确实落进代码，
// 且本插件自己发的微信里不再出现「回编号即可」的误导话术。图3「在微信里
// 直接选择」长文卡（wechatSyncGuide / /sessionlist 绑定步骤）已按用户要求删除。
assert.match(clientSrc, /function showInAppToast/, '应存在应用内浮层实现');
assert.ok(!/wechatSyncGuide/.test(clientSrc), '图3「在微信里直接选择」长文说明卡应已删除');
assert.ok(!/\/sessionlist/.test(clientSrc), '长文里的 /sessionlist 绑定步骤应随卡片一并删除');
assert.match(clientSrc, /\/use </, '实时推送文案仍应给出 /use 绑定命令');
assert.ok(!/微信回[「']?编号/.test(clientSrc), '微信文案不应再有「回编号即可」的误导话术');
ok('回归【m04774③】：真回填交 dsh-im 原生同步提问，图3长文说明卡已删，微信文案去掉误导话术');

// ── 回归【m03992 / m04774②】：微信极简超时提醒 + 双超时 ──
// 原决策：①清单式富文本 ②借 dsh-im 双向同步真回填 ③独立 attentionTimeoutSec
// 默认 60 秒 ④done 段突出「哪个会话完成了」⑤只本地修。
// m04774 实测清单文字墙太乱、且本插件发的微信收不到回复 → 改成「一行标题 +
// 每条会话一行 + 一句别在这条下回复」的极简留底；真回填交给 dsh-im 原生同步提问。
function drainBatch() {
  let g = 0;
  while (fakeWindow.__dshPluginWechatSession.debug().batch && batchTimeouts.length && g++ < 40) {
    batchTimer().fn();
  }
}
// 先排空前面测试留下的批次，并把配置设成显式值（含 Bot ID / 目标 ID），
// 让每个场景都从「没有活跃批次」起算，desp 用增量干净验证。
drainBatch();
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, null, 'm03992 起算前批次应为空');
store.set('dshPluginWechatSession.config', JSON.stringify({
  enabled: true, botId: 'wx_test_bot', targetId: 'tgt_test_target',
  timeoutSec: 30, attentionTimeoutSec: 60,
  sound: true, volume: 0.5, wechatEnabled: true, notifyPermission: true,
}));

// A. 需选择 / 确认类：真实 PendingQuestion，独立超时 60 秒。
//    微信只发「一行标题 + 会话一行 + 别在这条下回复」的极简提醒，
//    不再拼问题原文 / 编号选项 / 回复格式 / 绑定长文（m04774）。
setAway(true);
setSessions('sA', { sAsk: { displayTitle: '发布方案评审' } });
const tAsk0 = batchTimeouts.length;
const fAsk0 = fetchCalls.length;
pushStatus(new Map([
  ['sA', { running: true, completionUnread: false }],
  ['sAsk', {
    running: true,
    pendingInteraction: {
      kind: 'question', key: 'kAsk',
      questions: [{
        id: 'q1', question: '用哪种发布通道？', header: '发布',
        options: [
          { label: 'npm', description: '公共 registry' },
          { label: 'Gitee Release', description: '国内镜像' },
        ],
        multiSelect: false,
      }],
    },
    completionUnread: false,
  }],
]));
assert.equal(batchTimeouts.length, tAsk0 + 1, 'question 应起一个微信批次');
assert.equal(batchTimer().ms, 60000, '需选择/确认类独立超时 = 60 秒');
batchTimer().fn();
assert.equal(fetchCalls.length, fAsk0 + 1, '超时到期后发 1 条富格式卡');
const askBody = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
assert.equal(askBody.title, '', '富格式卡 title 留空');
const despAsk = askBody.desp;
assert.match(despAsk, /会话「发布方案评审」【 需要选择 】/, '富格式卡首行应带会话名 + 状态标签');
assert.match(despAsk, /\/use sask\n\n绑定 发布方案评审/, '富格式卡应带 /use <前缀> + 绑定 <标题> 两行');
assert.match(despAsk, /📌 正文：用哪种发布通道？/, '富格式卡正文应带具体问题');
assert.match(despAsk, /A npm/, '富格式卡选项应为 A/B/C 字母编号');
assert.match(despAsk, /B Gitee Release/, '富格式卡应列出 B 选项');
assert.ok(despAsk.includes('需要选择') && despAsk.includes('sask 1A 2B'), '需选择卡脚注应带实际前缀 + 数字字母回填码');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, null, '发完后批次应清空');
ok('功能融合：需选择类 60 秒超时发富格式卡（状态标签 + 正文 + 编号选项 + /use 绑定）');

// B. 任务跑完类：沿用 timeoutSec = 30 秒，极简微信里【已完成】段突出「哪个会话完成了」。
setSessions('sA', { sFin: { displayTitle: '周报生成' } });
const tFin0 = batchTimeouts.length;
const fFin0 = fetchCalls.length;
pushStatus(new Map([
  ['sA', { running: true, completionUnread: false }],
  ['sFin', { running: true, completionUnread: false }],
]));
pushStatus(new Map([
  ['sA', { running: true, completionUnread: false }],
  ['sFin', { running: false, completionUnread: true }],   // completionUnread 上升沿 → done
]));
assert.equal(batchTimeouts.length, tFin0 + 1, 'done 应起一个微信批次');
assert.equal(batchTimer().ms, 30000, '任务跑完类仍用 timeoutSec = 30 秒');
batchTimer().fn();
assert.equal(fetchCalls.length, fFin0 + 1, 'done 应发一条微信');
const finBody = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
assert.equal(finBody.title, '', 'done 富格式卡 title 留空');
const despFin = finBody.desp;
const finLines = despFin.split('\n\n');
assert.equal(finLines.length, 7, 'done 富格式卡应为 7 段（绑定指令拆两行）');
assert.match(finLines[0], /^DeepSeek Harness · 会话「周报生成」【 已完成 】 \d{2}:\d{2}:\d{2}$/, 'done 卡首行逐字');
assert.equal(finLines[1], '▸ 在微信里发送：', 'done 卡第 2 行逐字');
assert.equal(finLines[2], '/use sfin', 'done 卡第 3 行 = /use <前缀>');
assert.equal(finLines[3], '绑定 周报生成', 'done 卡第 4 行 = 绑定 <标题>');
assert.equal(finLines[4], '即可绑定该会话，之后可并行处理审批。 ', 'done 卡第 5 行逐字（行尾带空格）');
assert.equal(finLines[5], '📌 正文：任务已跑完，切过去查看回答全文', 'done 卡第 6 行正文引导逐字');
assert.equal(finLines[6], '—— 本条为实时状态提醒，勿在此回复 ——', 'done 卡第 7 行脚注逐字');
ok('功能融合：任务跑完类 30 秒超时发富格式卡（7 段逐字 + title 留空）');

// C. 两类混在一批：计时器对准最早 deadline，到点只发到期项，未到期项
//    留在批次里重排（不被提前一起发掉）——这是双超时不串台的关键。
setSessions('sA', { sFin2: { displayTitle: '任务甲' }, sChoice2: { displayTitle: '任务乙' } });
const fMix0 = fetchCalls.length;
pushStatus(new Map([
  ['sA', { running: true, completionUnread: false }],
  ['sFin2', { running: true, completionUnread: false }],
  ['sChoice2', { running: true, pendingInteraction: { kind: 'question', key: 'kChoice2', question: '下一步怎么做？' }, completionUnread: false }],
]));
pushStatus(new Map([
  ['sA', { running: true, completionUnread: false }],
  ['sFin2', { running: false, completionUnread: true }],  // done（30 秒，先到期）
  ['sChoice2', { running: true, pendingInteraction: { kind: 'question', key: 'kChoice2', question: '下一步怎么做？' }, completionUnread: false }],
]));
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, 2, '混批里应有 2 条（done + question）');
assert.ok(batchTimer().ms <= 30000 && batchTimer().ms > 29000,
  '混批计时器应对准最早那条 deadline（done 的 ~30 秒，不是 60 秒）');
batchTimer().fn();                                    // 只发到期的 done
assert.equal(fetchCalls.length, fMix0 + 1, '第一次只发到期项');
const mixBody1 = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
assert.equal(mixBody1.title, '');
const despMix1 = mixBody1.desp;
assert.match(despMix1, /会话「任务甲」【 已完成 】/, '第一次应只发到期的 done 富格式卡');
assert.ok(!/【 需要选择 】/.test(despMix1), '未到期的 question 不该被提前发掉');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, 1, '未到期项应留在批次里继续等');
batchTimer().fn();                                    // 发剩下到期的 question
assert.equal(fetchCalls.length, fMix0 + 2, '第二次发剩下的 question');
const mixBody2 = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
assert.equal(mixBody2.title, '');
const despMix2 = mixBody2.desp;
assert.match(despMix2, /会话「任务乙」【 需要选择 】/, '第二次应含 question 富格式卡');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, null, '全发完后批次应清空');
ok('功能融合：两类混批按各自 deadline 分次发富格式卡，30 秒的先发、60 秒的留到下一次，不串台');

// ── 回归【m05207】：只留一个弹窗 + 设置页卡片式分组 ──
// 用户反馈「浮层 + OS 横幅两个弹窗太复杂」「设置界面太丑」。按决策：
//   ① toast() 去掉 new Notification，每次提醒只挂 1 张应用内浮层；
//   ② 设置页重排成卡片式分组，顶部一大段说明收成可展开提示。
// 全量回归里已经发过很多次提醒，这里做一次「全程 0 个 OS 通知」的强校验。
assert.equal(osNotifications.length, 0,
  '整轮测试里不应再产生任何 new Notification（只留浮层一个弹窗）');
assert.ok(!/new Notification\s*\(/.test(clientSrc), '源码里不应再有 new Notification 调用');
assert.match(clientSrc, /function showInAppToast/, '唯一的弹窗应来自应用内浮层实现');
assert.match(clientSrc, /function toast[\s\S]{0,260}?showInAppToast\(/,
  'toast() 应直接调 showInAppToast()，不经 OS 通知分支');
ok('回归【m05207①】：全程只弹 1 类弹窗（应用内浮层），源码与运行态都不再有 OS 横幅');

// 设置页卡片式分组：源码级（分组标题 / card() / 可展开短说明），并再跑一次
// 渲染工厂确保重写后的整棵 React 树不抛异常。
assert.match(clientSrc, /function card\(/, '设置页应按主题渲染分组卡片');
assert.match(clientSrc, /groupBasic/, '应有「基础」分组');
assert.match(clientSrc, /groupBot/, '应有「微信机器人 / 目标」分组');
assert.match(clientSrc, /groupTimeout/, '应有「超时」分组');
assert.match(clientSrc, /groupAlert/, '应有「提醒方式」分组');
assert.ok(!/groupWechat/.test(clientSrc), '图3「在微信里直接选择」分组应已删除');
assert.match(clientSrc, /groupTest/, '应有「测试」分组');
assert.match(clientSrc, /aboutTitle/, '应有底部「关于本插件」信息卡');
assert.match(clientSrc, /sectionHintShort/, '顶部说明应收成简短副标题');
assert.match(clientSrc, /detailsLabel/, '完整说明应可展开（不再一上来一大段文字墙）');
assert.doesNotThrow(() => section.render(), '重排后的设置页渲染工厂应无异常');
ok('回归【m05207②】：设置页重排成卡片式分组（5 组 + 关于卡 + 可展开说明 + 主次按钮），渲染无异常');

// ── 新增【v1.8.0 选项1】：全会话实时分标签推送 + /session 串行切换 ──
// 目标：多个 DSH 会话 ↔ 单一微信私聊，直接在微信上实时交互。
// 一个微信私聊在 dsh-im 里任一时刻只能绑 1 个 DSH 会话，故走「选项1」：
//   下行 = 全会话状态变化立刻（不等超时）分标签推同一私聊，带会话 ID 与
//          /use 绑定命令；上行 = 用户在微信发 dsh-im 原生 /session 切会话。
//   回答全文 / 选项卡沿用 dsh-im 双向同步，不重复造轮子。
// ① 源码级：默认关、复用 postWechat、边沿接线、切换命令、设置页卡片。
assert.match(clientSrc, /realtimePush:\s*false/, 'DEFAULTS 里 realtimePush 默认关（零副作用）');
assert.match(clientSrc, /function postWechat\(/, '应有复用 Host /wechat 路由的低层 postWechat');
assert.match(clientSrc, /function summarizeRealtime\(/, '应有分标签拼装 summarizeRealtime');
assert.match(clientSrc, /function pushRealtime\(/, '应有全会话实时推送入口 pushRealtime');
assert.match(clientSrc, /pushRealtime\([\s\S]{0,80}?sid/, 'fireBatchTimeout 应把 sid 逐条传给 pushRealtime');
assert.match(clientSrc, /\/use \{prefix\}/, '实时微信应带 /use <前缀> 模板');
assert.match(clientSrc, /绑定 \{title\}/, '实时微信应带 绑定 <标题> 模板');
assert.match(clientSrc, /function sessionPrefix\(/, 'client 应有与宿主一致的短前缀算法');
assert.ok(!/card\(t\('groupRealtime'\)/.test(clientSrc), '功能融合：设置页独立的「多会话·实时推送」卡片渲染已删除');
assert.match(clientSrc, /function beginLogin\(/, '设置页应有扫码登录函数 beginLogin');
assert.equal(fakeWindow.__dshPluginWechatSession.config.realtimePush, false,
  'v1.8.0 新开关默认关，保证 54 项旧断言零漂移');
ok('功能融合【v1.8.0①】：源码级（postWechat / summarizeRealtime / pushRealtime 门禁 / /use 命令）齐备，实时卡已融合进超时发送');

// ── 功能融合【v1.8.0②/③】：富格式卡改为「超时到期后」发送 ──
// 用户要求功能融合：设置页只留超时设置；任务完成/需要选择/授予权限三类卡片沿用
// 原实时推送的富格式卡内容，但触发从「边沿即时」改为「超时到期后 fireBatchTimeout 逐条发」。
store.set('dshPluginWechatSession.config', JSON.stringify({
  enabled: true, botId: 'wx_rt_bot', targetId: 'tgt_rt_target',
  timeoutSec: 30, attentionTimeoutSec: 60, sound: false, volume: 0.5,
  wechatEnabled: true, notifyPermission: true,
}));
setAway(false);
setSessions('sA', { sRT: { displayTitle: '实时会话A' } });
drainBatch();                                   // 排空残留批次
const fRT0 = fetchCalls.length;
pushStatus(new Map([
  ['sA', { running: true }],
  ['sRT', { running: true, pendingInteraction: { kind: 'question', key: 'kRT', question: '选 A 还是 B？' }, completionUnread: false }],
]));
assert.equal(fetchCalls.length, fRT0, '功能融合：question 边沿不再立即发卡（改为超时到期后）');
assert.equal(batchTimer().ms, 60000, '需选择类仍是 60 秒超时');
batchTimer().fn();                              // 超时到期 → 发富格式卡
assert.equal(fetchCalls.length, fRT0 + 1, '超时到期后发 1 条富格式卡');
const rtBody = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
assert.equal(rtBody.title, '', '富格式卡 title 留空（整段作 desp）');
const rtQ = rtBody.desp.split('\n\n');
assert.equal(rtQ.length, 7, 'question 富格式卡应为 7 段');
assert.match(rtQ[0], /^DeepSeek Harness · 会话「实时会话A」【 需要选择 】 \d{2}:\d{2}:\d{2}$/,
  'question 卡首行逐字（状态标签 + HH:MM:SS）');
assert.equal(rtQ[1], '▸ 在微信里发送：', '指引第 2 行');
assert.equal(rtQ[2], '/use srt', '指引第 3 行 = /use <前缀>');
assert.equal(rtQ[3], '绑定 实时会话A', '指引第 4 行 = 绑定 <标题>');
assert.equal(rtQ[4], '即可绑定该会话，之后可并行处理审批。 ', '指引第 5 行（行尾带空格）');
assert.equal(rtQ[5], '📌 正文：选 A 还是 B？', '正文段独立成段');
assert.ok(rtQ[6].includes('需要选择') && rtQ[6].includes('srt 1A 2B'), 'question 卡脚注应带实际前缀 + 数字字母回填码');
ok('功能融合②：question 富格式卡超时到期后才发，7 段逐字');

// done 边沿同样超时后发（6 行逐字）；子代理静默；关微信开关不发
const fRT1 = fetchCalls.length;
pushStatus(new Map([
  ['sA', { running: true }],
  ['sRT', { running: false, completionUnread: true }],   // done 上升沿
]));
assert.equal(fetchCalls.length, fRT1, 'done 边沿也不立即发');
assert.equal(batchTimer().ms, 30000, '任务跑完类仍是 30 秒超时');
batchTimer().fn();
assert.equal(fetchCalls.length, fRT1 + 1, '超时到期后发 done 富格式卡');
const rtDone = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
assert.equal(rtDone.title, '', 'done 卡 title 留空');
const rtDoneLines = rtDone.desp.split('\n\n');
assert.equal(rtDoneLines.length, 7, 'done 卡应恰为 7 行');
assert.match(rtDoneLines[0], /^DeepSeek Harness · 会话「实时会话A」【 已完成 】 \d{2}:\d{2}:\d{2}$/,
  'done 卡首行逐字');
assert.equal(rtDoneLines[1], '▸ 在微信里发送：', 'done 卡第 2 行逐字');
assert.equal(rtDoneLines[2], '/use srt', 'done 卡第 3 行 = /use <前缀>');
assert.equal(rtDoneLines[3], '绑定 实时会话A', 'done 卡第 4 行 = 绑定 <标题>');
assert.equal(rtDoneLines[4], '即可绑定该会话，之后可并行处理审批。 ', 'done 卡第 5 行逐字（行尾带空格）');
assert.equal(rtDoneLines[5], '📌 正文：任务已跑完，切过去查看回答全文', 'done 卡第 6 行逐字');
assert.equal(rtDoneLines[6], '—— 本条为实时状态提醒，勿在此回复 ——', 'done 卡第 7 行脚注逐字');
ok('功能融合③：done 富格式卡超时到期后发，7 行逐字');

setSessions('sA', { sSub: { origin: 'subagent' } });
const fRT2 = fetchCalls.length;
pushStatus(new Map([
  ['sA', { running: true }],
  ['sSub', { running: true, pendingInteraction: { kind: 'question', key: 'kSub' }, completionUnread: false }],
]));
drainBatch();
assert.equal(fetchCalls.length, fRT2, '子代理会话不应触发富格式卡（isIgnoredSession 静默）');

// 门禁改为微信开关 wechatEnabled（不再是 realtimePush）
store.set('dshPluginWechatSession.config', JSON.stringify({
  enabled: true, botId: 'wx_rt_bot', targetId: 'tgt_rt_target',
  timeoutSec: 30, attentionTimeoutSec: 60, sound: false, volume: 0.5,
  wechatEnabled: false, notifyPermission: true,
}));
setSessions('sA', { sOff: { displayTitle: '关微信会话' } });
const fRT3 = fetchCalls.length;
pushStatus(new Map([
  ['sA', { running: true }],
  ['sOff', { running: true, pendingInteraction: { kind: 'question', key: 'kOff' }, completionUnread: false }],
]));
batchTimer().fn();
assert.equal(fetchCalls.length, fRT3, 'wechatEnabled 关掉后超时到期也不发富格式卡');
ok('功能融合③：子代理静默 / 关微信开关不发（门禁改用 wechatEnabled）');

// ── 功能融合去重：复用 realtimeDedupe 60s 窗口（触发改为 fireBatchTimeout） ──
store.set('dshPluginWechatSession.config', JSON.stringify({
  enabled: true, botId: 'wx_rt_bot', targetId: 'tgt_rt_target',
  timeoutSec: 30, attentionTimeoutSec: 60, sound: false, volume: 0.5,
  wechatEnabled: true, notifyPermission: true,
}));
setAway(false);
setSessions('sA', {
  sDone: { displayTitle: '微信·甜屿林风' },
  sDedup: { displayTitle: '去重会话' },
  sDedup2: { displayTitle: '另一会话' },
});
drainBatch();
const fD0 = fetchCalls.length;
let virtualNow = 1_700_000_000_000;
const RealDateNow = Date.now;
Date.now = () => virtualNow;

// 源码级常量/Map/失败撤销/上限齐备
assert.match(clientSrc, /var REALTIME_DEDUPE_WINDOW_MS = 60 \* 1000/, '去重窗口常量 60_000 ms');
assert.match(clientSrc, /var realtimeDedupe = new Map\(\)/, '应有内存去重 Map');
assert.match(clientSrc, /realtimeDedupe\.delete\(dedupeKey\)/, '发送失败应撤销该键以便重试');
assert.match(clientSrc, /REALTIME_DEDUPE_MAX_KEYS/, '应有 Map 上限防内存泄漏');

// ① 同一 done 卡 60s 内重复边沿只发一条
pushStatus(new Map([
  ['sA', { running: true }],
  ['sDone', { running: false, completionUnread: true }],
]));
assert.equal(fetchCalls.length, fD0, '边沿不立即发');
batchTimer().fn();
assert.equal(fetchCalls.length, fD0 + 1, '超时到期发第 1 条 done 卡');
const dedupeDone = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
assert.equal(dedupeDone.title, '', 'done 卡 title 留空');
const expectedClock = new Date(1_700_000_000_000).toLocaleTimeString('zh-CN');
const expectedDoneDesp = [
  `DeepSeek Harness · 会话「微信·甜屿林风」【 已完成 】 ${expectedClock}`,
  '▸ 在微信里发送：',
  '/use sdone',
  '绑定 微信·甜屿林风',
  '即可绑定该会话，之后可并行处理审批。 ',
  '📌 正文：任务已跑完，切过去查看回答全文',
  '—— 本条为实时状态提醒，勿在此回复 ——',
].join('\n\n');
assert.equal(dedupeDone.desp, expectedDoneDesp, 'done 卡在固定虚拟时钟下逐字等于 7 行模板');

pushStatus(new Map([
  ['sA', { running: true }],
  ['sDone', { running: false, completionUnread: false }],  // unread 回落清 doneBaseline
]));
assert.equal(fetchCalls.length, fD0 + 1, 'unread 回落不应触发富格式卡');
virtualNow += 2000;   // 跨过 doneAt 的 1000ms 去抖，仍在 60s 去重窗口内
pushStatus(new Map([
  ['sA', { running: true }],
  ['sDone', { running: false, completionUnread: true }],   // 再次形成 done 边沿
]));
batchTimer().fn();
assert.equal(fetchCalls.length, fD0 + 1,
  '同一会话同一 done 卡、60s 内重复边沿应被去重吞掉，不再发第二条');
ok('去重①：同键短时间重复被抑制（done 状态抖动只发 1 条）');

// ② 不同会话 / 不同正文 / 不同事件不受影响
pushStatus(new Map([
  ['sA', { running: true }],
  ['sDedup', { running: true, pendingInteraction: { kind: 'question', key: 'k1', question: '问题甲' }, completionUnread: false }],
]));
batchTimer().fn();
assert.equal(fetchCalls.length, fD0 + 2, '另一会话的 question 应正常发');
pushStatus(new Map([
  ['sA', { running: true }],
  ['sDedup', { running: true, pendingInteraction: { kind: 'question', key: 'k2', question: '问题乙' }, completionUnread: false }],
]));
batchTimer().fn();
assert.equal(fetchCalls.length, fD0 + 3, '同会话同事件但正文变了应正常发，不被去重误伤');
assert.match(JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body).desp, /问题乙/, '新问题的正文应出现在富格式卡里');
pushStatus(new Map([
  ['sA', { running: true }],
  ['sDedup2', { running: true, pendingInteraction: { kind: 'question', key: 'k3', question: '问题甲' }, completionUnread: false }],
]));
batchTimer().fn();
assert.equal(fetchCalls.length, fD0 + 4, '不同会话（键含 sid）不受影响');
pushStatus(new Map([
  ['sA', { running: true }],
  ['sDedup', { running: true, pendingInteraction: { kind: 'approval', key: 'k4', question: '确认运行' }, completionUnread: false }],
]));
batchTimer().fn();
assert.equal(fetchCalls.length, fD0 + 5, '不同事件类型（question→approval）不受影响');
ok('去重②：不同会话 / 不同正文 / 不同事件均正常发，去重零误伤');

// ③ 窗口过期后、内容仍相同也允许再发
virtualNow += 70_000;
pushStatus(new Map([
  ['sA', { running: true }],
  ['sDedup', { running: true, pendingInteraction: { kind: 'question', key: 'k5', question: '问题甲' }, completionUnread: false }],
]));
batchTimer().fn();
assert.equal(fetchCalls.length, fD0 + 6, '60s 窗口过期后同键可再发');
ok('去重③：60s 窗口过期后同键可再发（不是一次性永久禁用）');

Date.now = RealDateNow;   // 还原真实时钟

// ── 端到端：client 富格式卡 body → 真实 Host handler → iLink sendmessage ──
const sentTexts = [];
const e2eFetch = async (url, init) => {
  const u = String(url);
  let body = { ret: 0 };
  if (u.includes('getupdates')) body = { ret: -14, errcode: -14 };
  else if (u.includes('getconfig')) body = { typing_ticket: 'TICKET_SMOKE' };
  else if (u.includes('sendmessage')) {
    try {
      const payload = JSON.parse(init.body);
      sentTexts.push(payload?.msg?.item_list?.[0]?.text_item?.text || '');
    } catch { /* ignore */ }
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};
const hcE2E = makeHostCtx({}, { fetchImpl: e2eFetch });
const e2eRoute = hcE2E.registered.find((r) => r.path === host.WECHAT_ROUTE);
const e2eRes = await invoke(e2eRoute.handler, makeReq('POST', JSON.stringify({
  title: dedupeDone.title, desp: dedupeDone.desp,
})));
assert.equal(e2eRes.code, 200, '富格式卡 body 应被 Host 正常受理');
assert.equal(sentTexts.length, 1, '应经 iLink sendmessage 发一次');
assert.equal(sentTexts[0], expectedDoneDesp,
  '最终发到微信的 text 逐字等于 7 行定制模板（title 留空 → Host 不插空行）');
ok('端到端：client 富格式卡 → Host /wechat → iLink sendmessage，微信文本逐字对齐模板');

// ── 选项块：question 卡读真实 options，超时到期后发 ──
setSessions('sA', { sRT: { displayTitle: '实时会话A' } });
const fOpt = fetchCalls.length;
pushStatus(new Map([
  ['sA', { running: true }],
  ['sRT', { running: true, pendingInteraction: { kind: 'question', key: 'kOPT', questions: [{ question: '请选择方案', options: [{ label: '选项甲' }, { label: '选项乙' }, { label: '选项丙' }] }] }, completionUnread: false }],
]));
assert.equal(fetchCalls.length, fOpt, '选项块 question 边沿也不立即发');
batchTimer().fn();
assert.equal(fetchCalls.length, fOpt + 1, '超时到期后发带选项 question 卡');
const rtOpt = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
assert.equal(rtOpt.title, '', '带选项 question 卡 title 留空');
const rtOptSegs = rtOpt.desp.split('\n\n');
assert.equal(rtOptSegs.length, 10, '带选项 question 卡应为 10 段');
assert.match(rtOptSegs[0], /^DeepSeek Harness · 会话「实时会话A」【 需要选择 】 \d{2}:\d{2}:\d{2}$/, '首行逐字');
assert.equal(rtOptSegs[1], '▸ 在微信里发送：', '指引第 2 行');
assert.equal(rtOptSegs[2], '/use srt', '/use <前缀> 行');
assert.equal(rtOptSegs[3], '绑定 实时会话A', '绑定 <标题> 行');
assert.equal(rtOptSegs[4], '即可绑定该会话，之后可并行处理审批。 ', '指引第 5 行');
assert.equal(rtOptSegs[5], '📌 正文：请选择方案', '正文段');
assert.equal(rtOptSegs[6], 'A 选项甲', '选项 A');
assert.equal(rtOptSegs[7], 'B 选项乙', '选项 B');
assert.equal(rtOptSegs[8], 'C 选项丙', '选项 C');
assert.ok(rtOptSegs[9].includes('需要选择') && rtOptSegs[9].includes('srt 1A 2B'), '选项卡脚注应带实际前缀 + 数字字母回填码');
ok('功能融合：选项块 question 卡超时到期后发，读真实 options 编号成段');

// ── 多问题修复（m01440）：question 卡含 2+ 题时逐题输出「正文 + 选项」 ──
setSessions('sA', { sMQ: { displayTitle: '多问题会话' } });
const fMQ = fetchCalls.length;
pushStatus(new Map([
  ['sA', { running: true }],
  ['sMQ', { running: true, pendingInteraction: {
    kind: 'question', key: 'kMQ',
    questions: [
      { question: '第一题：选发布通道？', options: [{ label: 'npm' }, { label: 'Gitee' }] },
      { question: '第二题：是否同时发通知？', options: [{ label: '发群消息' }, { label: '不发' }] },
    ],
  }, completionUnread: false }],
]));
assert.equal(fetchCalls.length, fMQ, '多问题 question 边沿也不立即发');
batchTimer().fn();
assert.equal(fetchCalls.length, fMQ + 1, '超时到期后发多问题 question 卡');
const mq = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
assert.equal(mq.title, '', '多问题卡 title 留空');
const mqSegs = mq.desp.split('\n\n');
// 首行 + 指引 4 行（绑定指令拆两行）+ [第1题正文 + 2 选项] + [第2题正文 + 2 选项] + 脚注 = 12 段
assert.equal(mqSegs.length, 12, '两题卡应为 12 段（每题正文+选项，脚注 1）');
assert.equal(mqSegs[2], '/use smq', '/use <前缀> 行');
assert.equal(mqSegs[3], '绑定 多问题会话', '绑定 <标题> 行');
assert.equal(mqSegs[5], '📌 正文：第一题：选发布通道？', '第 1 题正文');
assert.equal(mqSegs[6], 'A npm', '第 1 题选项 A');
assert.equal(mqSegs[7], 'B Gitee', '第 1 题选项 B');
assert.equal(mqSegs[8], '📌 正文：第二题：是否同时发通知？', '第 2 题正文');
assert.equal(mqSegs[9], 'A 发群消息', '第 2 题选项 A');
assert.equal(mqSegs[10], 'B 不发', '第 2 题选项 B');
assert.ok(mqSegs[11].includes('需要选择') && mqSegs[11].includes('smq 1A 2B'), '多问题卡脚注应带实际前缀 + 数字字母回填码');
ok('多问题修复：2 题卡逐题输出正文+选项，单题输出保持原样');


// ── 宿主计时根治（m00713）：Node 定时器准点发卡 + 取消 + 跨通道去重 ──
{
  const clockSent = [];
  const clockFetch = async (url, init) => {
    const u = String(url);
    let body = { ret: 0 };
    if (u.includes('getupdates')) body = { ret: -14, errcode: -14 }; // 不挂起长轮询
    else if (u.includes('getconfig')) body = { typing_ticket: 'TICKET_CLOCK' };
    else if (u.includes('sendmessage')) {
      try {
        const payload = JSON.parse(init.body);
        clockSent.push(payload?.msg?.item_list?.[0]?.text_item?.text || '');
      } catch { /* ignore */ }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const hcClock = makeHostCtx({}, { fetchImpl: clockFetch });
  const nc = hcClock.registered.find((r) => r.path === host.NOTIFY_CLOCK_ROUTE);
  assert.ok(nc && typeof nc.handler === 'function', '应注册 notify-clock 宿主计时路由');
  const postClock = (obj) => invoke(nc.handler, makeReq('POST', JSON.stringify(obj)));

  // 非 POST → 405；无 dedupeKey → 400
  assert.equal((await invoke(nc.handler, makeReq('GET', null))).code, 405, 'notify-clock 拒绝非 POST');
  assert.equal((await postClock({ title: 'x' })).code, 400, 'notify-clock 缺 dedupeKey → 400');

  // 预约 20ms 后发卡，Node 定时器不受浏览器节流 → 90ms 内必准点发出
  const res1 = await postClock({ dedupeKey: 'clock-A', title: '宿主计时', desp: '准点发卡', deadline: Date.now() + 20, kind: 'question', sid: 'sClockA' });
  assert.equal(res1.code, 200);
  assert.equal(JSON.parse(res1.body).scheduled, true, '预约应返回 scheduled:true');
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(clockSent.length, 1, '宿主 Node 定时器准点发出 1 条卡');
  assert.match(clockSent[0], /宿主计时/, '发的卡内容应是预约时的 title');

  // 取消预约：schedule 后立刻 cancel，等待后不应发
  const res2 = await postClock({ dedupeKey: 'clock-B', title: '会被取消', deadline: Date.now() + 20, kind: 'question', sid: 'sClockB' });
  assert.equal(JSON.parse(res2.body).scheduled, true);
  const resCancel = await postClock({ dedupeKey: 'clock-B', action: 'cancel' });
  assert.equal(JSON.parse(resCancel.body).cancelled, true, '取消应返回 cancelled:true');
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(clockSent.length, 1, '取消预约后不应再发卡');
  ok('宿主计时根治（m00713）：Node 定时器准点发卡 + 取消预约不误发');

  // 跨通道去重：宿主计时器已 claim 'clock-A'，wechat 带同 key 再来应被吞
  const wr = hcClock.registered.find((r) => r.path === host.WECHAT_ROUTE);
  const wres = await invoke(wr.handler, makeReq('POST', JSON.stringify({
    title: '重复卡', desp: '同 dedupeKey', dedupeKey: 'clock-A', kind: 'question', sid: 'sClockA',
  })));
  assert.equal(wres.code, 200);
  assert.equal(JSON.parse(wres.body).suppressed, 'duplicate', '同 dedupeKey 后到应被去重吞掉');
  assert.equal(clockSent.length, 1, '去重后不应再发第 2 条');
  ok('宿主计时根治（m00713）：宿主计时器与 wechat 共用 dedupeKey，先到 claim 后到吞掉');
}

// ── 清理：停掉所有 host 长轮询 + 删除 smoke 临时状态文件 ──
for (const hc of allHostCtxs) hc.dispose();
for (const f of [STATE_MAIN, STATE_IDLE, DELIVER_STATE, LOGIN_STATE, BINDING_FILE, SETTINGS_FILE]) {
  await unlink(f).catch(() => {});
}

console.log(`\n全部通过：${passed} 项断言。`);
