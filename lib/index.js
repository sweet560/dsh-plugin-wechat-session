// dsh-plugin-wechat-session — Host half.
//
// 职责很窄：只提供一条同源回环路由，把浏览器半边要发的「微信通知」交给
// dsh-im（@xmanrui/dsh-im）的主动投递服务 ctx.dshIm.send(botId, targetId, text)，
// 由它从已接入的微信机器人发到用户指定的那一个微信目标。不再经过 Server 酱，
// 也不需要任何外部 Webhook / SendKey。
//
// 触发判定、桌面通知、提示音、30 秒计时全部在浏览器半边（lib/client.js）。
// 宿主不订阅任何会话事件，避免与页面重复投递。
//
// v1.1.1：兼容把 dsh-im「复制调用参数」的整段 JSON 误粘进单个输入框的情况，
// 并把 dsh-im 抛回的英文错误（如 "Invalid target id"）翻成中文原因。
// v1.2.0：升级为聚合包——cordis.patch.yml 一次挂两条 loader 行（本插件 + dsh-im），
// 装这一个包就同时带上微信提醒与微信机器人；dsh-im 仍走 npm 官方源可独立升级。
// v1.3.0：浏览器半边改为会话级提醒 / 会话级「已响应」，修复多会话并行时
// 其他会话不通知也不发微信的 bug。Host half 的运行逻辑不变。
// v1.4.0：浏览器半边去掉重复的空白系统通知、给「任务跑完」通知加会话名与
// 点击跳转。Host half 的运行逻辑不变。
// v1.5.0：浏览器半边三类事件都弹「带具体内容、对齐 dsh-pet 格式」的系统通知，
// 点击一律跳到对应会话。Host half 的运行逻辑不变。

export const name = 'dsh-plugin-wechat-session';
export const VERSION = '1.7.0';

// 顶层硬依赖：webServer 用来注册路由，connection 用来做 HTTP 准入裁决。
// dshIm 是 dsh-im 提供的「软依赖」，用 ctx.inject 按需绑定（见 apply）——
// 这样即便 dsh-im 未安装 / 未就绪，本插件仍能挂载（只是发微信会返回明确错误），
// 不会因为缺一个第三方服务就拖垮整个 profile 的启动。
// 与 DSH-better-sidebar 的 src/index.ts:115 / :1425 一致。
export const inject = ['webServer', 'connection'];

const ROUTE_BASE = '/__dsh-plugin-wechat-session';
export const WECHAT_ROUTE = `${ROUTE_BASE}/wechat`;
export const HEALTH_ROUTE = `${ROUTE_BASE}/health`;

const SEND_TIMEOUT_MS = 10_000;
const BODY_LIMIT = 64 * 1024;
// 微信渠道长文本会按 1800 字分段（每段占一次平台发送次数）。汇总提醒本就不长，
// 这里再兜底截断，避免异常长的 desp 把一条提醒拆成刷屏。
const TEXT_LIMIT = 1800;

// ───────────────── ID 归一化（v1.1.1 容错） ─────────────────
// dsh-im 设置页「复制调用参数」给出的是一整段 JSON：
//   {"botId":"wx_d0301fd63db4606cc9d5cea","targetId":"tgt_4912086eb0a42cb0"}
// 用户很自然会把整段粘进「微信目标 ID」这一栏。dsh-im 对 targetId 的校验是
// /^[A-Za-z0-9._:@-]{1,128}$/，整段 JSON 会直接抛 "Invalid target id"。
// 这里把整段 JSON 自动拆回两个纯 ID，用户不必手动裁切。
function splitPair(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // 纯 ID 直接跳过（targetId 允许含冒号，所以不能只靠 ':' 判断）。
  if (!(s.charAt(0) === '{' || /["']?(botId|targetId)["']?\s*[:=]/i.test(s))) return null;
  let botId = null;
  let targetId = null;
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v !== 'string' || !v.trim()) continue;
        const nk = k.toLowerCase().replace(/[\s_-]/g, '');
        if (nk === 'botid') botId = v.trim();
        else if (nk === 'targetid') targetId = v.trim();
      }
    }
  } catch (error) {
    // JSON 不合法时退化为正则抓取（容忍复制时夹带的换行 / 反引号 / 尾逗号）。
    const b = /["']?botId["']?\s*[:=]\s*["']([^"']+)["']/i.exec(s);
    const g = /["']?targetId["']?\s*[:=]\s*["']([^"']+)["']/i.exec(s);
    if (b) botId = b[1].trim();
    if (g) targetId = g[1].trim();
  }
  return botId || targetId ? { botId, targetId } : null;
}

// 两个输入里只要有一个是整段 JSON，就用解析结果补齐 / 覆盖两个纯 ID。
function normalizeIds(rawBotId, rawTargetId) {
  let botId = typeof rawBotId === 'string' ? rawBotId.trim() : '';
  let targetId = typeof rawTargetId === 'string' ? rawTargetId.trim() : '';
  for (const raw of [botId, targetId]) {
    const pair = splitPair(raw);
    if (!pair) continue;
    if (pair.botId) botId = pair.botId;
    if (pair.targetId) targetId = pair.targetId;
  }
  return { botId, targetId };
}

function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  return normalizeIds(c.botId, c.targetId);
}

// ───────────────── 错误中文化 ─────────────────
// dsh-im 抛回的错误多为英文（Error.message + Error.code）。设置页「测试微信推送」
// 直接显示人能看懂的中文原因，而不是一坨 JSON 或英文报错。
function humanizeError(raw, code) {
  const text = String(raw || '');
  const key = String(code || '');
  const table = [
    [/Invalid target id|invalid-target/i,
      '目标 ID 格式不对：这一栏只填 tgt_xxx 这种纯 ID，不要把「复制调用参数」的整段 JSON 粘进来。'],
    [/Invalid bot id|invalid-bot/i,
      'Bot ID 格式不对：这一栏只填 wx_xxx / bot_xxx 这种纯 ID。'],
    [/unknown-target/i,
      'dsh-im 里找不到这个目标 ID，请在 dsh-im「设置 → IM机器人」重新点「复制调用参数」。'],
    [/unknown-bot/i,
      'dsh-im 里找不到这个 Bot ID，请在 dsh-im 设置页重新复制。'],
    [/bot-not-connected/i,
      '微信机器人当前离线，请到 dsh-im「设置 → IM机器人」确认已连接。'],
    [/target-rejected/i,
      '微信平台拒绝了这个目标，请检查 dsh-im 里的目标配置（微信目标需填 toUserId）。'],
    [/delivery-failed|ret=-2|prepare failed/i,
      '微信平台发送失败。若刚升级 / 重启过 dsh-im，让目标用户给机器人发一条消息重建缓存后再试。'],
    [/cancelled|aborted|timeout|timed out/i,
      '发送超时或被取消，请稍后重试。'],
    [/dshim-unavailable/i,
      'dsh-im 服务还没就绪：请确认已启用 dsh-im 插件，并重新打开 DSH。'],
    [/missing-target/i,
      '还没填 Bot ID / 目标 ID：请到 dsh-im 设置页复制「调用参数」后填入。'],
    [/missing-text/i, '提醒内容为空，没有可发送的文字。'],
    [/invalid-json/i, '请求格式不对（不是合法 JSON）。'],
  ];
  for (const [re, message] of table) {
    if (re.test(text) || re.test(key)) return message;
  }
  return text || '未知错误';
}

function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, reason: 'body-too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
      } catch (error) {
        finish({ ok: false, reason: 'invalid-body' });
      }
    });
    req.on('error', () => finish({ ok: false, reason: 'request-error' }));
  });
}

// dsh-im 主动投递：result.sent !== true 一律视为失败。
// 契约见 @xmanrui/dsh-im/PROACTIVE_DELIVERY.md：
//   ctx.dshIm.send(botId, targetId, text, { signal, format? }) -> { sent: true }
async function sendViaDshIm(imService, botId, targetId, text) {
  if (!imService || typeof imService.send !== 'function') {
    return {
      ok: false,
      error: 'dshim-unavailable',
      message: humanizeError('', 'dshim-unavailable'),
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const result = await imService.send(botId, targetId, text, { signal: controller.signal });
    if (result && result.sent === true) return { ok: true, sent: true };
    const raw = result && (result.error || result.message)
      ? String(result.error || result.message)
      : 'delivery-not-sent';
    const code = result && result.code ? String(result.code) : '';
    return {
      ok: false,
      error: 'delivery-not-sent',
      detail: result || null,
      message: humanizeError(raw, code),
    };
  } catch (error) {
    const raw = String((error && error.message) || error);
    const code = error && error.code ? String(error.code) : '';
    return {
      ok: false,
      error: raw,
      code: code || undefined,
      message: humanizeError(raw, code),
    };
  } finally {
    clearTimeout(timer);
  }
}

function makeWechatHandler(ctx, cfg, getIm) {
  // 统一准入：仅当 requestRejection 返回 undefined 时放行（不自建信任例外）。
  const fence = (req) => ctx.connection.requestRejection(req) === undefined;

  return async function wechatHandler(req, res) {
    if (!fence(req)) {
      respond(res, 403, { ok: false, error: 'forbidden', message: '请求未通过 DSH 准入裁决。' });
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      respond(res, 405, { ok: false, error: 'method-not-allowed', message: '只接受 POST 请求。' });
      return;
    }
    const read = await readBody(req);
    if (!read.ok) {
      respond(res, 413, { ok: false, error: read.reason, message: '请求体过大或读取失败。' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(read.text || '{}');
    } catch (error) {
      respond(res, 400, { ok: false, error: 'invalid-json', message: humanizeError('', 'invalid-json') });
      return;
    }
    const title = String(payload.title || '').slice(0, 256).trim();
    const desp = String(payload.desp || '').slice(0, 32 * 1024);
    // botId / targetId 由设置页保存到 localStorage，随请求传来；
    // 留空时回退到 cordis.patch.yml 的 config.botId / config.targetId（服务端兜底）。
    // 两者都可能是被误粘进来的整段 JSON，统一在这里归一化。
    const ids = normalizeIds(payload.botId || cfg.botId || '', payload.targetId || cfg.targetId || '');
    const botId = ids.botId;
    const targetId = ids.targetId;
    const text = (title && desp ? title + '\n\n' + desp : title || desp).slice(0, TEXT_LIMIT);
    if (!text) {
      respond(res, 400, { ok: false, error: 'missing-text', message: humanizeError('', 'missing-text') });
      return;
    }
    if (!botId || !targetId) {
      respond(res, 400, { ok: false, error: 'missing-target', message: humanizeError('', 'missing-target') });
      return;
    }
    const result = await sendViaDshIm(getIm(), botId, targetId, text);
    if (!result.ok) {
      ctx.logger?.warn?.('[dsh-plugin-wechat-session] dsh-im 微信投递失败: ' + (result.message || result.error || ''));
    }
    respond(res, result.ok ? 200 : 502, result);
  };
}

function makeHealthHandler(ctx, cfg, getIm) {
  const fence = (req) => ctx.connection.requestRejection(req) === undefined;
  return function healthHandler(req, res) {
    if (!fence(req)) {
      respond(res, 403, { ok: false });
      return;
    }
    respond(res, 200, {
      ok: true,
      name,
      version: VERSION,
      hasServerTarget: Boolean(cfg.botId && cfg.targetId),
      dshImReady: Boolean(getIm()),
    });
  };
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  let imService = null;

  // 软依赖：dsh-im 把主动投递服务挂成 ctx.dshIm。用 inject + effect 绑定，
  // 服务失效 / 重新挂载时自动解绑。写法照抄 dsh-notify-me/lib/index.js:697
  // 的 ctx.inject(['webServer'], ...) + effect。
  try {
    ctx.inject(['dshIm'], (imCtx) => {
      imCtx.effect(() => {
        imService = imCtx.dshIm || null;
        if (imService) ctx.logger?.info?.('[dsh-plugin-wechat-session] dshIm 已就绪');
        return () => { imService = null; };
      }, 'dsh-plugin-wechat-session: bind dshIm');
    });
  } catch (error) {
    ctx.logger?.warn?.('[dsh-plugin-wechat-session] dshIm 绑定失败: ' + String(error));
  }

  const getIm = () => imService;
  const routes = [
    { path: WECHAT_ROUTE, handler: makeWechatHandler(ctx, cfg, getIm) },
    { path: HEALTH_ROUTE, handler: makeHealthHandler(ctx, cfg, getIm) },
  ];
  // 与 DSH-better-sidebar src/index.ts:1613 一致：register 的返回值直接作为
  // effect 的清理函数，保证禁用 / HMR 时路由自动撤销。
  for (const route of routes) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      `dsh-plugin-wechat-session: host route ${route.path}`,
    );
  }
  ctx.logger?.info?.('[dsh-plugin-wechat-session] host routes ready');
}
