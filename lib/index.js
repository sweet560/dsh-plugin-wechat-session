// dsh-plugin-wechat-session — Host half（v2.1.0 通道外设版）。
//
// 架构：本插件不再"拥有会话"，也不再依赖 @xmanrui/dsh-im。
//   - ChannelTransport（lib/channel/transport.js）：纯 iLink 适配器，只做微信协议。
//   - SessionEventBridge + ApprovalGate（lib/host/bridge.js）：宿主侧只读事件订阅 +
//     approval/request waterfall 应答者，全部走 DSH 官方 seam，不 import 任何 dsh-im 内部模块。
//   - 会话绑定由用户在微信侧显式指定（/use <会话ID>），插件只持有 Set<显式会话ID>，
//     没有"当前活跃会话"的隐式概念。
//
// 触发判定、桌面通知、提示音、浮层呈现仍在浏览器半边（lib/client.js）。
// 宿主侧只提供：微信 HTTP 回环路由（兼容原 client）、扫码登录路由、以及事件/审批 seam。

import { randomUUID } from 'node:crypto';
import { createTransport } from './channel/transport.js';
import { createBridge, sessionPrefix, humanizeError } from './host/bridge.js';
import { createBindingStore } from './host/binding-store.js';
import { createSettingsStore } from './host/settings-store.js';
import qrcode from '../vendor/qrcode.cjs';

export const name = 'dsh-plugin-wechat-session';
export const VERSION = '2.1.0';

// 顶层硬依赖：webServer 注册路由，connection 做 HTTP 准入裁决。
export const inject = ['webServer', 'connection'];

const ROUTE_BASE = '/__dsh-plugin-wechat-session';
export const WECHAT_ROUTE = `${ROUTE_BASE}/wechat`;
export const HEALTH_ROUTE = `${ROUTE_BASE}/health`;
export const LOGIN_ROUTE = `${ROUTE_BASE}/login`;
export const LOGIN_STATUS_ROUTE = `${ROUTE_BASE}/login-status`;
export const INBOUND_ROUTE = `${ROUTE_BASE}/inbound`;
export const SESSIONS_ROUTE = `${ROUTE_BASE}/sessions`;
export const QR_IMAGE_ROUTE = `${ROUTE_BASE}/qr.png`;
export const SETTINGS_ROUTE = `${ROUTE_BASE}/settings`;

const BODY_LIMIT = 64 * 1024;
const TEXT_LIMIT = 1800;

function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// v2.0.0 修正：iLink 的 qrcode_img_content 是一个二维码「网页 URL」（text/html），
// 不是图片 base64。旧实现把它当 base64 解码导致破图。这里用内置 vendor 的纯 JS
// 二维码库把 URL 文本编码成 GIF 图片，直接内嵌到设置页，不跳转、零 npm 运行时依赖。
function renderQrImage(res, url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad-protocol');
    const qr = qrcode(0, 'M');
    qr.addData(parsed.href);
    qr.make();
    const dataUrl = qr.createDataURL(6, 2);
    const buf = Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    res.writeHead(200, {
      'content-type': 'image/gif',
      'cache-control': 'no-store',
      'content-length': buf.length,
    });
    res.end(buf);
  } catch {
    respond(res, 400, { ok: false, error: 'invalid-qr' });
  }
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) { finish({ ok: false, reason: 'body-too-large' }); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try { finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }); }
      catch { finish({ ok: false, reason: 'invalid-body' }); }
    });
    req.on('error', () => finish({ ok: false, reason: 'request-error' }));
  });
}

function parseJson(read, res) {
  if (!read.ok) { respond(res, 413, { ok: false, error: read.reason, message: '请求体过大或读取失败。' }); return null; }
  try { return JSON.parse(read.text || '{}'); }
  catch { respond(res, 400, { ok: false, error: 'invalid-json', message: '请求格式不对（不是合法 JSON）。' }); return null; }
}

export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const fence = (req) => ctx.connection?.requestRejection?.(req) === undefined;
  const disposers = [];

  // ── 设置持久化（/new 新建会话的工作目录）──
  // 设置页写的值优先，cordis.patch.yml 的 cfg.newSessionCwd 作为兜底。
  const settingsStore = createSettingsStore(cfg.settingsFile);
  let newSessionCwd = settingsStore.load().newSessionCwd || cfg.newSessionCwd || '';

  // ── ChannelTransport：纯 iLink 适配器 ──
  let bridge = null;
  const transport = createTransport({
    config: cfg,
    log: (msg) => ctx.logger?.info?.(`[wechat-session] ${msg}`),
    onStatus: (status) => {
      ctx.logger?.info?.(`[wechat-session] 微信通道状态: ${status.status}`);
    },
    onMessage: (msg) => {
      const text = transport.messageText(msg);
      if (!text || !bridge) return;
      ctx.logger?.info?.(`[wechat-session] 入站微信: ${text.slice(0, 120)}`);
      bridge.handleInbound(text).catch((e) => ctx.logger?.warn?.(`[wechat-session] 入站处理失败: ${e}`));
    },
  });

  // ── SessionEventBridge + ApprovalGate ──
  const bridgeSend = async (text) => {
    const r = await transport.sendText(text.slice(0, TEXT_LIMIT));
    if (!r.ok) throw new Error(r.error || '微信发送失败');
    return r;
  };

  // 最小探针 / 对话功能入站：微信普通文本 → 固定会话的官方 prompt seam。
  // 网页聊天框"发送"走的同一入口；不创建会话、不碰 dsh-im。
  // SessionPromptRequest = { requestId, sessionId, mode:'queue', content:[{type:'text',text}] }
  const submitPrompt = async (sessionId, text) => {
    // cordis 严格 inject：未声明的依赖用 ctx.sessionController 属性访问会直接抛
    // 「cannot get property ... without inject」，短路求值连 ctx.get 都走不到。
    // ctx.get() 是对已注册服务的软获取，不要求 inject 声明，取不到返回 undefined。
    let controller = null;
    try { controller = ctx.get?.('sessionController'); } catch (e) { controller = null; }
    if (!controller || typeof controller.prompt !== 'function') {
      ctx.logger?.warn?.('[wechat-session] sessionController.prompt 不可用，对话入站未启用');
      return { accepted: false, error: 'sessionController 不可用' };
    }
    // 归档会话闸门：宿主 prompt 入口不检查归档（归档闸门在 agent/pre-step），
    // 归档会话本体仍在持久化中、prompt 会把消息静默入队，用户以为发出去了却没反应。
    // 这里在投递前先查 workspaceRegistry.archivedSessionIds，命中则明确拒绝。
    // ctx.get 软获取（cordis 严格 inject 安全）；取不到 registry 时跳过检查（降级）。
    try {
      const registry = ctx.get?.('workspaceRegistry');
      const archived = registry?.archivedSessionIds;
      let isArchived = false;
      if (archived) {
        if (typeof archived.has === 'function') isArchived = archived.has(sessionId);
        else if (Array.isArray(archived)) isArchived = archived.indexOf(sessionId) !== -1;
      }
      if (isArchived) {
        return { accepted: false, error: '该会话已归档或已删除，无法发送消息。请用 /use 绑定其它会话， /new 创建新会话。' };
      }
    } catch (e) { /* 取不到归档集合时跳过检查，保持原行为 */ }
    const request = {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai',
    };
    await controller.prompt(request, new AbortController().signal);
    return { accepted: true };
  };

  // 按会话标题短名反查 sessionId（微信「绑定 <标题>」用）。
  // 组合两个官方 seam：sessionController.list 拿 sessionId 列表 + sessionQuery.readTitle
  // 逐个读标题。两者都用 ctx.get 软获取（cordis 严格 inject 下属性访问会抛错）。
  // 返回 {ok:true,sessionId,title} | {ok:false,matches:[{sessionId,title}]} | {ok:false,error}。
  const resolveSessionByTitle = async (rawTitle) => {
    const query = String(rawTitle || '').trim();
    if (!query) return { ok: false, error: '标题为空' };
    let controller = null;
    let sessionQuery = null;
    try { controller = ctx.get?.('sessionController'); } catch (e) { controller = null; }
    try { sessionQuery = ctx.get?.('sessionQuery'); } catch (e) { sessionQuery = null; }
    if (!controller || typeof controller.list !== 'function') {
      return { ok: false, error: 'sessionController 不可用' };
    }
    // 列举会话（SessionListValue.items: SessionSummary[]，含 sessionId 但不含 title）。
    let items;
    try {
      const value = await controller.list({}, new AbortController().signal);
      items = Array.isArray(value?.items) ? value.items : [];
    } catch (e) {
      return { ok: false, error: `列举会话失败：${humanizeError(e)}` };
    }
    const ids = items.map((s) => s?.sessionId).filter(Boolean);
    // 逐个读标题（SessionTitleSnapshot.title）。sessionQuery 不可用时退回以 ID 为标题。
    const rows = [];
    for (const sid of ids) {
      let titleText = '';
      if (sessionQuery && typeof sessionQuery.readTitle === 'function') {
        try {
          const snap = await sessionQuery.readTitle(sid, new AbortController().signal);
          titleText = String(snap?.title || '');
        } catch (e) { /* 单条读标题失败不影响其余 */ }
      }
      rows.push({ sessionId: sid, title: titleText || String(sid) });
    }
    // 匹配：精确 > 前缀 > 包含；唯一命中直接绑定，多命中返回候选列表。
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s·•\-_]/g, '');
    const q = norm(query);
    const tiers = [
      (r) => norm(r.title) === q,
      (r) => { const t = norm(r.title); return t.startsWith(q) || (q.length >= 2 && q.startsWith(t)); },
      (r) => norm(r.title).includes(q),
    ];
    for (const test of tiers) {
      const hits = rows.filter(test);
      if (hits.length === 1) return { ok: true, sessionId: hits[0].sessionId, title: hits[0].title };
      if (hits.length > 1) return { ok: false, matches: hits.map((h) => ({ sessionId: h.sessionId, title: h.title })) };
    }
    return { ok: false, error: '未找到匹配标题' };
  };

  // 按会话短前缀反查 sessionId（卡片里的「/use <前缀>」用）。
  // 卡片针对的会话可能尚未绑定，故不能只查已绑定集合——用 controller.list 列全部会话，
  // 逐个算与宿主一致的 sessionPrefix 做精确匹配。返回形状与 resolveSessionByTitle 一致。
  const resolveSessionByPrefix = async (rawPrefix) => {
    const query = String(rawPrefix || '').trim().toLowerCase();
    if (!query) return { ok: false, error: '前缀为空' };
    let controller = null;
    try { controller = ctx.get?.('sessionController'); } catch (e) { controller = null; }
    if (!controller || typeof controller.list !== 'function') {
      return { ok: false, error: 'sessionController 不可用' };
    }
    let items;
    try {
      const value = await controller.list({}, new AbortController().signal);
      items = Array.isArray(value?.items) ? value.items : [];
    } catch (e) {
      return { ok: false, error: `列举会话失败：${humanizeError(e)}` };
    }
    const hits = items
      .map((s) => s?.sessionId)
      .filter(Boolean)
      .filter((sid) => sessionPrefix(sid, cfg.prefixLength || 6) === query);
    if (hits.length === 1) return { ok: true, sessionId: hits[0] };
    if (hits.length > 1) return { ok: false, matches: hits.map((sid) => ({ sessionId: sid })) };
    return { ok: false, error: '未找到匹配前缀' };
  };

  // 读取会话标题（正文镜像抬头「DeepSeek Harness · 会话「标题」」用）。
  // 与 resolveSessionByTitle 同源：sessionQuery.readTitle；ctx.get 软获取（严格 inject 安全）。
  // 取不到时 bridge 会退回短前缀，不影响功能。
  const sessionTitle = async (sid) => {
    let sessionQuery = null;
    try { sessionQuery = ctx.get?.('sessionQuery'); } catch (e) { sessionQuery = null; }
    if (!sessionQuery || typeof sessionQuery.readTitle !== 'function') return '';
    try {
      const snap = await sessionQuery.readTitle(sid, new AbortController().signal);
      return String(snap?.title || '');
    } catch (e) { return ''; }
  };

  // 薄创建新会话：微信 /new → workspace/create({path}) 拿 workspaceId →
  // sessionController.create({workspaceId}) → resume → rename。全部 @Remote，走 ctx.get 软获取。
  // 只创建并立即交给 bridge 当绑定目标，不维护会话池/清理/映射表——权威仍在 DSH。
  // 关键：workspaceId 与 cwd 互斥，只有 workspaceId 才让会话进入指定工作区分组；
  // 只传 cwd 的会话不属于任何 workspace，列表会显示「未分组」（真机反馈 + asar 契约）。
  const createSession = async (title) => {
    let controller = null;
    let workspaces = null;
    try { controller = ctx.get?.('sessionController'); } catch (e) { controller = null; }
    try { workspaces = ctx.get?.('workspaceController'); } catch (e) { workspaces = null; }
    if (!controller || typeof controller.create !== 'function') {
      return { ok: false, error: 'sessionController.create 不可用' };
    }
    const cwd = String(newSessionCwd || '').trim();
    let createRequest = {};
    if (cwd && workspaces && typeof workspaces.create === 'function') {
      // 注册/幂等解析该目录为工作区，拿 workspaceId 让会话进对应分组。
      try {
        const ws = await workspaces.create({ path: cwd }, new AbortController().signal);
        const wid = ws?.workspace?.workspaceId;
        if (wid) createRequest = { workspaceId: wid };
        else ctx.logger?.warn?.('[wechat-session] 工作区解析未返回 workspaceId，退回默认位置');
      } catch (e) {
        return { ok: false, error: `工作目录注册为工作区失败：${humanizeError(e)}` };
      }
    } else if (cwd) {
      // 宿主没有 workspaceController 时退回 cwd（会话可能落「未分组」，如实降级）。
      createRequest = { cwd };
    }
    let created;
    try {
      created = await controller.create(createRequest, new AbortController().signal);
    } catch (e) {
      return { ok: false, error: `创建会话失败：${humanizeError(e)}` };
    }
    // create 返回的 sessionId 可能 ≠ 请求值，必须用返回值。
    const sessionId = created?.sessionId;
    if (!sessionId) return { ok: false, error: '创建会话未返回 sessionId' };
    // 命名：自定义内容加「微信 · 」前缀；缺省为「微信 · Clawbot」；已带前缀则不重复加。
    const rawTitle = String(title || '').trim();
    const baseTitle = rawTitle || 'Clawbot';
    const finalTitle = /^微信\s*[·•]/i.test(baseTitle) ? baseTitle : `微信 · ${baseTitle}`;
    // rename 契约要求「先显式 resume 会话」；resume/rename 失败都不影响会话创建本身。
    if (typeof controller.rename === 'function') {
      try {
        if (typeof controller.resume === 'function') {
          await controller.resume({ sessionId }, new AbortController().signal);
        }
        await controller.rename({ sessionId, title: finalTitle }, new AbortController().signal);
      } catch (e) {
        ctx.logger?.warn?.(`[wechat-session] 会话重命名失败: ${e}`);
      }
    }
    return { ok: true, sessionId, title: finalTitle };
  };

  bridge = createBridge({
    config: {
      prefixLength: cfg.prefixLength || 6,
      approvalTimeoutMs: cfg.approvalTimeoutMs || 300_000,
      remindIntervalMs: cfg.remindIntervalMs || 60_000,
      maxReminders: cfg.maxReminders ?? 3,
      permissionPreset: cfg.permissionPreset || 'ask',
      questionTimeoutMs: cfg.questionTimeoutMs || 0,
      summaryIntervalMs: cfg.summaryIntervalMs || 0,
      sessionEventMentions: cfg.sessionEventMentions,
    },
    send: bridgeSend,
    submitPrompt,
    resolveSessionByTitle,
    resolveSessionByPrefix,
    createSession,
    sessionTitle,
    newSessionTitle: cfg.newSessionTitle || '微信 · Clawbot',
    // 绑定状态持久化：与 iLink state 同目录，重启/插件重载后自动恢复绑定。
    // cfg.bindingFile 可覆盖路径（测试用）；缺省走 ~/.dsh-plugin-wechat-session/bindings.json。
    bindingStore: createBindingStore(cfg.bindingFile),
    log: (msg) => ctx.logger?.info?.(`[wechat-session] ${msg}`),
  });

  // 官方 seam：只读事件订阅 + 审批 waterfall 应答者。
  try {
    disposers.push(ctx.on('session/event', (session, event) => bridge.onSessionEvent(session, event)));
  } catch (e) { ctx.logger?.warn?.(`[wechat-session] session/event 订阅失败: ${e}`); }
  // dsh 0.1.5 起 live 正文走 agent/assistant-stream（不再进 session/event log）。
  // 订阅它才能在对话回复仍在生成时就把正文镜像回微信。
  try {
    disposers.push(ctx.on('agent/assistant-stream', (payload) => bridge.onAssistantStream(payload)));
  } catch (e) { ctx.logger?.warn?.(`[wechat-session] agent/assistant-stream 订阅失败: ${e}`); }
  try {
    disposers.push(ctx.on('approval/request', (request, next) => bridge.onApprovalRequest(request, next)));
  } catch (e) { ctx.logger?.warn?.(`[wechat-session] approval/request 订阅失败: ${e}`); }
  // ask_user_question 选择题：waterfall 应答者，回调返回 answer 即回填。
  // 传 next 让未绑定会话能与原生 UI 应答器竞答（谁先答谁生效）。
  try {
    disposers.push(ctx.on('user-questions/request', (request, next) => bridge.onUserQuestions(request, next)));
  } catch (e) { ctx.logger?.warn?.(`[wechat-session] user-questions/request 订阅失败: ${e}`); }

  transport.start();

  // ── HTTP 路由 ──

  // 兼容原 client.js：把浮层文案回环到微信（现在走 iLink，不再经 dsh-im）。
  const wechatHandler = async (req, res) => {
    if (!fence(req)) { respond(res, 403, { ok: false, error: 'forbidden', message: '请求未通过 DSH 准入裁决。' }); return; }
    if (String(req.method || 'GET').toUpperCase() !== 'POST') { respond(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
    const payload = parseJson(await readBody(req), res);
    if (!payload) return;
    const title = String(payload.title || '').slice(0, 256).trim();
    const desp = String(payload.desp || '').slice(0, 32 * 1024);
    const text = (title && desp ? title + '\n\n' + desp : title || desp).slice(0, TEXT_LIMIT);
    if (!text) { respond(res, 400, { ok: false, error: 'missing-text', message: '提醒内容为空。' }); return; }
    const r = await transport.sendText(text);
    respond(res, r.ok ? 200 : 502, r);
  };

  // 扫码登录：POST 开始 / GET 状态 / qr.png 二维码图。
  const loginHandler = async (req, res) => {
    if (!fence(req)) { respond(res, 403, { ok: false, error: 'forbidden' }); return; }
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'POST') {
      try {
        const state = await transport.beginLogin();
        respond(res, 200, { ok: true, ...state });
      } catch (e) { respond(res, 502, { ok: false, error: String(e?.message || e) }); }
      return;
    }
    if (method === 'DELETE') {
      transport.cancelLogin();
      respond(res, 200, { ok: true, ...transport.getLoginState() });
      return;
    }
    respond(res, 405, { ok: false, error: 'method-not-allowed' });
  };
  const loginStatusHandler = (req, res) => {
    if (!fence(req)) { respond(res, 403, { ok: false, error: 'forbidden' }); return; }
    respond(res, 200, { ok: true, ...transport.getLoginState() });
  };
  const qrHandler = (req, res) => {
    if (!fence(req)) { respond(res, 403, { ok: false }); return; }
    const img = transport.getLoginState().qrcodeImgContent;
    if (!img) { respond(res, 404, { ok: false, error: 'no-qrcode' }); return; }
    renderQrImage(res, img);
  };

  // 入站测试：把一段文本当作微信入站消息走 bridge 指令解析（便于设置页调试）。
  const inboundHandler = async (req, res) => {
    if (!fence(req)) { respond(res, 403, { ok: false, error: 'forbidden' }); return; }
    if (String(req.method || 'GET').toUpperCase() !== 'POST') { respond(res, 405, { ok: false }); return; }
    const payload = parseJson(await readBody(req), res);
    if (!payload) return;
    const result = await bridge.handleInbound(String(payload.text || ''));
    respond(res, 200, { ok: true, ...result });
  };

  // 会话绑定查看（设置页/健康页）：返回已绑定会话与未决审批。
  const sessionsHandler = (req, res) => {
    if (!fence(req)) { respond(res, 403, { ok: false, error: 'forbidden' }); return; }
    respond(res, 200, {
      ok: true,
      bound: bridge.boundList().map((id) => ({ id, prefix: sessionPrefix(id, cfg.prefixLength || 6) })),
      pending: bridge.registry.snapshot(),
    });
  };

  // /new 新建会话的工作目录：GET 读当前值，POST 写入并持久化到 settings.json。
  const settingsHandler = async (req, res) => {
    if (!fence(req)) { respond(res, 403, { ok: false, error: 'forbidden' }); return; }
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      respond(res, 200, { ok: true, newSessionCwd });
      return;
    }
    if (method === 'POST') {
      const payload = parseJson(await readBody(req), res);
      if (!payload) return;
      newSessionCwd = String(payload.newSessionCwd || '').slice(0, 2048).trim();
      settingsStore.save({ newSessionCwd });
      respond(res, 200, { ok: true, newSessionCwd });
      return;
    }
    respond(res, 405, { ok: false, error: 'method-not-allowed' });
  };

  const healthHandler = (req, res) => {
    if (!fence(req)) { respond(res, 403, { ok: false }); return; }
    const s = transport.getLoginState();
    respond(res, 200, {
      ok: true, name, version: VERSION,
      wechatReady: s.status === 'ready' && s.hasToken,
      loginStatus: s.status,
      boundSessions: bridge.boundList().length,
    });
  };

  const routes = [
    { path: WECHAT_ROUTE, handler: wechatHandler },
    { path: HEALTH_ROUTE, handler: healthHandler },
    { path: LOGIN_ROUTE, handler: loginHandler },
    { path: LOGIN_STATUS_ROUTE, handler: loginStatusHandler },
    { path: QR_IMAGE_ROUTE, handler: qrHandler },
    { path: INBOUND_ROUTE, handler: inboundHandler },
    { path: SESSIONS_ROUTE, handler: sessionsHandler },
    { path: SETTINGS_ROUTE, handler: settingsHandler },
  ];
  for (const route of routes) {
    const off = ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler });
    disposers.push(off);
  }

  ctx.effect(() => () => {
    for (const off of disposers) { try { off?.(); } catch { /* ignore */ } }
    bridge.dispose();
    transport.dispose();
  }, 'dsh-plugin-wechat-session: dispose');

  ctx.logger?.info?.('[dsh-plugin-wechat-session] host routes + seams ready (v' + VERSION + ')');
}
