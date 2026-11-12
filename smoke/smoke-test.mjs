// dsh-plugin-wechat-session 冒烟测试（纯 Node，无需真实 DSH 宿主）。
// 运行：npm test
//
// 覆盖：
//   1. 清单契约（package.json / cordis.patch.yml / locale / icon）
//   2. Host half：路由注册、准入裁决、dsh-im 主动投递（ctx.dshIm.send）、错误分支
//   3. Client half：模块包装导出、配置读写、设置页与 watchers 能无异常挂载、四类回归

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const root = new URL('../', import.meta.url);
const readText = (p) => readFile(new URL(p, root), 'utf8');
const readJson = async (p) => JSON.parse(await readText(p));
let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

// ───────────────────── 1. 清单 / 静态文件 ─────────────────────
const pkg = await readJson('package.json');
assert.equal(pkg.name, 'dsh-plugin-wechat-session');
assert.equal(pkg.version, '1.6.0');
assert.equal(pkg.type, 'module');
assert.equal(pkg.main, 'lib/index.js');
assert.equal(pkg.icon, 'icon.svg');
assert.equal(pkg.dsh.manifestVersion, 1);
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(pkg.dsh.client.platform, 'web');
assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length >= 1);
assert.equal(pkg.exports['.'], './lib/index.js');
assert.equal(pkg.exports['./client'], './lib/client.js');
ok('package.json 基本字段与 dsh 声明（v1.6.0 三类都弹带内容通知 + 会话级聚合包）');

// 聚合包：声明可升级范围的 dsh-im 直接依赖，装伞包自动带上微信机器人
assert.ok(pkg.dependencies?.['@xmanrui/dsh-im'], '缺少 @xmanrui/dsh-im 依赖');
assert.match(pkg.dependencies['@xmanrui/dsh-im'], /\^|>=|~|\*/, 'dsh-im 必须是可升级版本范围，不能锁死精确版本');
ok('聚合包声明可升级的 dsh-im 依赖（保证随时能拉最新版）');

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
assert.match(patch, /botId: ''/);
assert.match(patch, /targetId: ''/);
assert.ok(!/sendKey/.test(patch), 'patch 不应再有 sendKey');
ok('cordis.patch.yml 挂载行 + botId/targetId 服务端兜底');

// 聚合包：一次 insert 挂两条 entry，第二条把 dsh-im 也挂上且带防重守卫
const entryNameMatches = patch.match(/^\s*- id:/gm) || [];
assert.equal(entryNameMatches.length, 2, 'patch 应恰好有两条 loader entry（本插件 + dsh-im）');
assert.match(patch, /name: '@xmanrui\/dsh-im'/, '第二条 entry 的 name 必须等于包名（client 半边按 name 扫描）');
assert.match(patch, /disabled: !!js/, 'dsh-im 那一行必须带 name 级防重复挂载守卫');
assert.match(patch, /e\.options\.id !== 'dsh-plugin-wechat-session-dsh-im'/, '守卫必须带自排除，否则会把自身判成 disabled');
ok('聚合包一次挂两个插件（第二条 name=@xmanrui/dsh-im 且带自排除守卫）');

for (const loc of ['en', 'zh']) {
  const dict = await readJson(`locale/${loc}.json`);
  assert.ok(dict.meta?.title, `${loc}.json 缺 meta.title`);
  assert.ok(dict.meta?.description, `${loc}.json 缺 meta.description`);
  assert.ok(!/ServerChan|Server 酱/i.test(dict.meta.description), `${loc}.json 不应再提 Server 酱`);
}
ok('locale/en.json + zh.json（en 为发现基线，描述已改 dsh-im）');

const icon = await readText('icon.svg');
assert.match(icon, /<svg[\s\S]*width="36"[\s\S]*height="36"/);
assert.match(icon, /linearGradient/);
ok('icon.svg 36×36 双色渐变');

// 代码里彻底不再有 Server 酱调用痕迹（配置键 / URL / 出库 fetch）
for (const f of ['lib/index.js', 'lib/client.js']) {
  const src = await readText(f);
  assert.ok(!/sctapi|sct\.ftqq\.com|ServerChan|serverchan/i.test(src), `${f} 不应残留 Server 酱调用`);
  assert.ok(!/\bsendKey\b/.test(src), `${f} 不应残留 sendKey 标识符`);
  assert.ok(!/globalThis\.fetch|fetch\(['"]https:/.test(src), `${f} 不应有外部 Webhook fetch`);
}
ok('代码彻底移除 Server 酱 / sctapi / sendKey（改走 dsh-im）');

// ───────────────────── 2. Host half ─────────────────────
const host = await import(new URL('../lib/index.js', import.meta.url).href);
assert.equal(host.name, 'dsh-plugin-wechat-session');
assert.deepEqual(host.inject, ['webServer', 'connection']);
assert.equal(typeof host.apply, 'function');
assert.match(host.WECHAT_ROUTE, /^\/__dsh-plugin-wechat-session\/wechat$/);
assert.match(host.HEALTH_ROUTE, /^\/__dsh-plugin-wechat-session\/health$/);
ok('lib/index.js 导出 name/inject/apply/路由常量');

let rejection = undefined; // undefined = 放行；403 = 拒绝
const sendCalls = [];      // 所有 ctx.dshIm.send 调用
let sendResult = { sent: true };
let sendThrow = null;      // 非 null 时让 dshIm.send 抛错（模拟 dsh-im 校验失败）
const fakeImService = {
  async send(botId, targetId, text, opts) {
    sendCalls.push({ botId, targetId, text, opts });
    if (sendThrow) throw sendThrow;
    return sendResult;
  },
};

// Host 的 dshIm 是「软依赖」：apply 用 ctx.inject(['dshIm'], cb) 绑定。
// mock 里复刻这个绑定，让 imService 指向 fakeImService。
function makeHostCtx(config, opts = {}) {
  const registered = [];
  const imCtx = {
    dshIm: opts.withIm === false ? undefined : fakeImService,
    effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {}; },
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    connection: { requestRejection() { return rejection; } },
    webServer: { register(route) { registered.push(route); return () => {}; } },
    inject(names, cb) { if (names.includes('dshIm') && !opts.noInject) cb(imCtx); },
    effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {}; },
  };
  host.apply(ctx, config);
  return { ctx, registered };
}

const { registered } = makeHostCtx({ botId: 'HOST_BOT', targetId: 'HOST_TARGET' });
assert.equal(registered.length, 2, '应注册 2 条 exact 路由');
assert.ok(registered.every((r) => r.kind === 'exact' && typeof r.handler === 'function'));
ok('apply 注册 2 条 exact 路由（含准入裁决）');

const wechatRoute = registered.find((r) => r.path === host.WECHAT_ROUTE);
const healthRoute = registered.find((r) => r.path === host.HEALTH_ROUTE);
assert.ok(wechatRoute && healthRoute);

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
let res = await invoke(healthRoute.handler, makeReq('GET', null));
assert.equal(res.code, 403);
rejection = undefined;
ok('requestRejection 非 undefined 时拒绝（403）');

// 2b. health 放行 → 200，报 hasServerTarget / dshImReady
res = await invoke(healthRoute.handler, makeReq('GET', null));
assert.equal(res.code, 200);
const health = JSON.parse(res.body);
assert.equal(health.hasServerTarget, true);
assert.equal(health.dshImReady, true);
ok('health 路由放行并返回 hasServerTarget / dshImReady');

// 2c. 非 POST → 405
res = await invoke(wechatRoute.handler, makeReq('GET', null));
assert.equal(res.code, 405);
ok('wechat 路由拒绝非 POST（405）');

// 2d. 缺 Bot ID / 目标 ID → 400 missing-target（页面没给、服务端也没配）
const empty = makeHostCtx({});
const wEmpty = empty.registered.find((r) => r.path === host.WECHAT_ROUTE);
res = await invoke(wEmpty.handler, makeReq('POST', JSON.stringify({ title: 'x' })));
assert.equal(res.code, 400);
assert.equal(JSON.parse(res.body).error, 'missing-target');
ok('缺 Bot ID / 目标 ID 时报 400 missing-target');

// 2e. dsh-im 主动投递：校验 send(botId,targetId,text,{signal}) 参数
sendCalls.length = 0;
sendResult = { sent: true };
res = await invoke(wechatRoute.handler, makeReq('POST', JSON.stringify({
  title: 'DSH 需要你看一下',
  desp: '离开窗口超过 30 秒没有回来：\n\n- 需要确认权限·会话A',
  botId: 'PAGE_BOT',
  targetId: 'PAGE_TARGET',
})));
assert.equal(res.code, 200, '投递成功应回 200');
assert.equal(JSON.parse(res.body).ok, true);
assert.equal(sendCalls.length, 1, '应调用一次 ctx.dshIm.send');
assert.equal(sendCalls[0].botId, 'PAGE_BOT');
assert.equal(sendCalls[0].targetId, 'PAGE_TARGET');
assert.match(sendCalls[0].text, /DSH 需要你看一下/);
assert.match(sendCalls[0].text, /需要确认权限/);
assert.ok(sendCalls[0].opts && sendCalls[0].opts.signal, '应传 AbortSignal');
assert.ok(sendCalls[0].text.length <= 1800, '微信长文本应截到 1800 字以内');
ok('Host 把 {title,desp,botId,targetId} 交给 dshIm.send 主动投递');

// 2f. 服务端兜底（cordis.patch.yml 的 config.botId / config.targetId）
sendCalls.length = 0;
res = await invoke(wechatRoute.handler, makeReq('POST', JSON.stringify({ title: '兜底' })));
assert.equal(res.code, 200);
assert.equal(sendCalls[0].botId, 'HOST_BOT');
assert.equal(sendCalls[0].targetId, 'HOST_TARGET');
ok('页面未给 ID 时回退到 config.botId / config.targetId');

// 2g. 平台未接受（sent !== true）→ 502 delivery-not-sent
sendResult = { sent: false, error: 'delivery-failed' };
res = await invoke(wechatRoute.handler, makeReq('POST', JSON.stringify({
  title: '重试场景', botId: 'PAGE_BOT', targetId: 'PAGE_TARGET',
})));
assert.equal(res.code, 502);
assert.equal(JSON.parse(res.body).error, 'delivery-not-sent');
sendResult = { sent: true };
ok('dshIm.send 返回 sent!==true 时回 502 delivery-not-sent');

// 2h. dsh-im 未就绪 → 502 dshim-unavailable（软依赖不拖垮挂载）
const noIm = makeHostCtx({ botId: 'B', targetId: 'T' }, { withIm: false });
const wNoIm = noIm.registered.find((r) => r.path === host.WECHAT_ROUTE);
res = await invoke(wNoIm.handler, makeReq('POST', JSON.stringify({
  title: 'x', botId: 'B', targetId: 'T',
})));
assert.equal(res.code, 502);
assert.equal(JSON.parse(res.body).error, 'dshim-unavailable');
ok('dshIm 服务未就绪时回 502 dshim-unavailable（软依赖不拖垮挂载）');

// 2i. 【v1.1.1 回归】把 dsh-im「复制调用参数」的整段 JSON 误粘进目标 ID 栏：
//     Host 自动拆回两个纯 ID，不再把整段丢给 dsh-im 触发 "Invalid target id"。
//     这正是用户截图里「测试微信推送」失败的真实场景。
sendCalls.length = 0;
sendResult = { sent: true };
// 用户截图里粘贴的实际是小写键 {"botid":...,"targetid":...}，用真实数据形态验证。
const pastedPair = JSON.stringify({ botid: 'wx_d0301fd63db4606cc9d5cea', targetid: 'tgt_4912086eb0a42cb0' });
res = await invoke(wechatRoute.handler, makeReq('POST', JSON.stringify({
  title: 'DSH 需要你看一下',
  desp: '测试',
  botId: 'wx_d0301fd63db4606cc9d5cea',
  targetId: pastedPair, // 用户把整段粘进了「微信目标 ID」框
})));
assert.equal(res.code, 200, '整段 JSON 应被自动拆分后成功投递');
assert.equal(sendCalls.length, 1);
assert.equal(sendCalls[0].botId, 'wx_d0301fd63db4606cc9d5cea');
assert.equal(sendCalls[0].targetId, 'tgt_4912086eb0a42cb0', 'targetId 应是纯 ID 而非整段 JSON');
assert.ok(!/[{}"]/.test(sendCalls[0].targetId), '交给 dsh-im 的 targetId 不能含 JSON 字符');
ok('回归：整段「复制调用参数」JSON 误粘进单栏时自动拆成两个纯 ID');

// 2i-2. 驼峰键 botId/targetId 同样要能拆（dsh-im 源码复制的是驼峰，用户可能粘小写）。
sendCalls.length = 0;
const pastedCamel = JSON.stringify({ botId: 'wx_d0301fd63db4606cc9d5cea', targetId: 'tgt_4912086eb0a42cb0' });
res = await invoke(wechatRoute.handler, makeReq('POST', JSON.stringify({
  title: 'x', desp: '测试', botId: 'wx_d0301fd63db4606cc9d5cea', targetId: pastedCamel,
})));
assert.equal(res.code, 200);
assert.equal(sendCalls[0].targetId, 'tgt_4912086eb0a42cb0', '驼峰键也应拆成纯 targetId');
ok('回归：驼峰键整段 JSON 同样自动拆成两个纯 ID');

// 2j. 【v1.1.1 回归】dsh-im 抛英文校验错误时，返回体带中文 message。
sendThrow = Object.assign(new Error('Invalid target id'), { code: 'invalid-target' });
res = await invoke(wechatRoute.handler, makeReq('POST', JSON.stringify({
  title: 'x', botId: 'PAGE_BOT', targetId: 'PAGE_TARGET',
})));
assert.equal(res.code, 502);
const errBody = JSON.parse(res.body);
assert.match(errBody.message, /目标 ID|纯 ID|复制调用参数/, '英文报错应翻成中文原因');
assert.ok(!/^Invalid target id$/.test(errBody.message || ''), '不应再把原始英文直接抛给设置页');
sendThrow = null;
ok('回归：dsh-im 英文错误（Invalid target id）翻成中文 message');

// ───────────────────── 3. Client half ─────────────────────
const clientSrc = await readText('lib/client.js');
const ReactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
};
const store = new Map();
const listeners = {};             // vm 内 uiSession.subscribe 回调写这里
const winListeners = {};          // window 事件回调：type -> [fn]
const docListeners = {};          // document 事件回调：type -> [fn]
const createdNotifications = [];  // 所有 new Notification 实例
const fetchCalls = [];            // 所有 sendWechat 的 fetch
const batchTimeouts = [];         // root.setTimeout 的调用（30 秒批次计时）
const clearedTimeouts = [];       // root.clearTimeout 的调用（取消批次）
const miscTimeouts = [];          // 裸 setTimeout（toast 自动关闭等）
const permissionRequests = [];    // m03179：Notification.requestPermission 调用记录
let timerSeq = 0;

function addListener(bag, type, fn) { (bag[type] || (bag[type] = [])).push(fn); }
function fire(bag, type) { (bag[type] || []).forEach((fn) => { try { fn({}); } catch (e) {} }); }

class FakeNotification {
  constructor(title, opts) { this.title = title; this.opts = opts; this.closed = false; createdNotifications.push(this); }
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
const fakeDocument = {
  hidden: true, visibilityState: 'hidden', hasFocus: () => false,
  body: { appendChild() {} },
  createElement() { return { style: {}, remove() {} }; },
  addEventListener(type, fn) { addListener(docListeners, type, fn); },
  removeEventListener(type, fn) { const a = docListeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
};
const controlledSetTimeout = (fn, ms) => { const id = ++timerSeq; miscTimeouts.push({ id, fn, ms }); return id; };
const sandbox = {
  window: fakeWindow,
  self: fakeWindow,
  document: fakeDocument,
  Notification: FakeNotification,
  fetch: async (url, opts) => { fetchCalls.push({ url, opts }); return { json: async () => ({ ok: true }) }; },
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

// apply 之前就塞「陈旧」状态：插件加载那一刻挂着的待办 / 已完成都不该补发提醒。
let fakeUiStatus = new Map([
  ['s0', { running: false, pendingInteraction: { kind: 'approval', key: 'old' }, completionUnread: true }],
]);
// sessions.list 快照：current 指「界面正停在哪条会话」（v1.3.0 会话级判据的数据源）。
let fakeListSnapshot = { current: 'sA', byId: {} };
const listListeners = {};   // vm 内 sessions.list.subscribe 回调写这里

const slotsInjected = [];
const registeredSections = [];
const effects = [];
const openSessionCalls = [];   // jumpToSession → ctx.get('uiWorkspace').openSession(sid)
const fakeCtx = {
  get(name) {
    if (name === 'uiSession') return { sessionStatus: fakeStatusStore };
    if (name === 'sessions') return { list: fakeListStore };
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
assert.equal(sentBody.title, 'DSH 需要你看一下');
assert.ok('botId' in sentBody && 'targetId' in sentBody, '转发体应带 botId/targetId');
assert.ok(!('sendKey' in sentBody), '转发体不应再有 sendKey');
ok('回归：前台 30 秒没切过去看/没处理 → 汇总成一条微信经 Host 转发');

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
// 旧版此刻弹窗会被 permission 门槛整段跳过且永不重试；修复后 toast 会先
// ensurePermission() 重新申请（mock 里同步授予），因此仍能弹出这张卡。
FakeNotification.permission = 'default';
const reqBefore = permissionRequests.length;
const notesFix0 = createdNotifications.length;
fakeWindow.__dshPluginWechatSession.testDesktop();
assert.equal(permissionRequests.length, reqBefore + 1,
  '权限丢失为 default 时，提醒前应主动重新申请通知权限');
assert.equal(FakeNotification.permission, 'granted', '重新申请后权限应恢复为 granted');
assert.equal(createdNotifications.length, notesFix0 + 1,
  '权限刚恢复的场景下，桌面弹窗仍应真正弹出（不再静默失败）');
const fixNote = createdNotifications[createdNotifications.length - 1];
assert.notEqual(fixNote.opts.silent, true, '新通知不能是静音的（系统提示音兜底保留）');
ok('回归【m03179】：后台 + 权限丢失(default)时仍主动申请并弹出通知，不再无声无息');

// ── 回归【m03992】：微信清单（像图1那样列问题原文 + 编号选项）+ 双超时 ──
// 五项决策：①清单式富文本 ②借 dsh-im 双向同步真回填（配置指引）③独立
// attentionTimeoutSec 默认 60 秒 ④done 段突出「哪个会话完成了」⑤只本地修。
// 旧版只拼 "- label（时间）"，没有问题/选项，也没法在微信里直接选。
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

// A. 需选择 / 确认类：真实 PendingQuestion（问题原文 + 编号选项），
//    独立超时 60 秒，微信清单里要出现会话名、问题、1) 2) 选项、回复格式与 dsh-im 绑定指引。
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
assert.equal(fetchCalls.length, fAsk0 + 1, '清单应发一条微信');
const despAsk = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body).desp;
assert.match(despAsk, /【等你拍板】/, '清单应有「等你拍板」段');
assert.match(despAsk, /会话「发布方案评审」/, '应写清是哪条会话');
assert.match(despAsk, /用哪种发布通道？/, '应含问题原文（不再是 label+时间）');
assert.match(despAsk, /1\) npm/, '应含编号选项 1');
assert.match(despAsk, /2\) Gitee Release/, '应含编号选项 2');
assert.match(despAsk, /微信回/, '应给出「回编号/批准」的回复格式');
assert.match(despAsk, /双向同步/, '应给 dsh-im 双向同步（真回填）配置指引');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, null, '发完后批次应清空');
ok('回归【m03992】：需选择类 60 秒超时把问题原文+编号选项列成图1式清单发微信（含会话名/回复格式/dsh-im 绑定指引）');

// B. 任务跑完类：沿用 timeoutSec = 30 秒，清单【已完成】段突出「哪个会话完成了」。
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
const despFin = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body).desp;
assert.match(despFin, /【已完成】/, '清单应有「已完成」段');
assert.match(despFin, /会话「周报生成」已完成/, '应一眼看出是哪个会话完成了');
ok('回归【m03992】：任务跑完类仍 30 秒，微信清单【已完成】段突出「会话「XXX」已完成」');

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
const despMix1 = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body).desp;
assert.match(despMix1, /【已完成】/, '第一次应只含「已完成」');
assert.ok(!/【等你拍板】/.test(despMix1), '未到期的 question 不该被提前发掉');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, 1, '未到期项应留在批次里继续等');
batchTimer().fn();                                    // 发剩下到期的 question
assert.equal(fetchCalls.length, fMix0 + 2, '第二次发剩下的 question');
const despMix2 = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body).desp;
assert.match(despMix2, /【等你拍板】/, '第二次应含「等你拍板」');
assert.equal(fakeWindow.__dshPluginWechatSession.debug().batch, null, '全发完后批次应清空');
ok('回归【m03992】：两类混批按各自 deadline 分次发，30 秒的先发、60 秒的留到下一次，不串台');

console.log(`\n全部通过：${passed} 项断言。`);
