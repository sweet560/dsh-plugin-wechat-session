/**
 * dsh-plugin-wechat-session — ChannelTransport（纯 iLink 适配器 / 会话外设）。
 *
 * 只负责微信协议本身：扫码登录、长轮询收消息、发送文本、typing 状态。
 * 不 import 任何 DSH 包（纯 Node：node:crypto / node:fs / node:os / node:path）。
 * 协议层来自 lib/channel/ilink.mjs（移植自 gtaifu/dsh-wechat-bridge，依据官方 SDK）。
 *
 * 主动发送（审批卡/提醒/汇总）不需要 contextToken（iLink 允许省略），
 * 因此本适配器与「会话拥有」解耦：它只认一个微信 bot + 一个扫码用户，
 * 不创建、不映射任何 DSH 会话。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIlinkClient, extractText, STALE_TOKEN_ERRCODE } from './ilink.mjs';

const DEFAULT_STATE_FILE = path.join(os.homedir(), '.dsh-plugin-wechat-session', 'ilink-state.json');

function readStateFile(file) {
  try {
    if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

function writeStateFile(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch { /* ignore */ }
}

/**
 * @param {object} opts
 *   opts.config      - 插件配置（stateFile / baseUrl / channelVersion / botAgent /
 *                      loginPollMs / receiveLongPollMs 等）
 *   opts.log         - 日志函数
 *   opts.onMessage   - (msg) => void，收到的微信消息回调
 *   opts.onStatus    - (status) => void，登录/连接状态变化回调
 */
export function createTransport(opts = {}) {
  const config = opts.config || {};
  const log = opts.log || (() => {});
  const onMessage = opts.onMessage || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const stateFile = config.stateFile || DEFAULT_STATE_FILE;

  const persisted = readStateFile(stateFile);
  let state = {
    token: persisted.token || '',
    botId: persisted.botId || '',
    baseUrl: persisted.baseUrl || '',
    userId: persisted.userId || '',
    getUpdatesBuf: persisted.getUpdatesBuf || '',
    typingTicket: persisted.typingTicket || '',
    typingTicketAt: persisted.typingTicketAt || 0,
  };

  let ilink = createIlinkClient({
    baseUrl: state.baseUrl || undefined,
    token: state.token || undefined,
    channelVersion: config.channelVersion || '2.4.6',
    botAgent: config.botAgent || 'dsh-plugin-wechat-session',
    log,
    fetchImpl: config.fetchImpl,
  });

  let loginState = { status: state.token ? 'ready' : 'idle', qrcode: '', qrcodeImgContent: '' };
  let loginAbort = null;
  let receiveAbort = null;
  let started = false;
  let disposed = false;

  function save() {
    writeStateFile(stateFile, state);
  }

  function emitStatus(patch = {}) {
    loginState = { ...loginState, ...patch };
    onStatus(getLoginState());
  }

  function getLoginState() {
    return {
      status: loginState.status,
      qrcode: loginState.qrcode,
      qrcodeImgContent: loginState.qrcodeImgContent,
      botId: state.botId,
      userId: state.userId,
      hasToken: Boolean(state.token),
    };
  }

  function applyCredentials({ token, botId, baseUrl, userId }) {
    state.token = token || state.token;
    state.botId = botId || state.botId;
    state.userId = userId || state.userId;
    if (baseUrl) {
      state.baseUrl = baseUrl;
      ilink.setBaseUrl(baseUrl);
    }
    ilink.setToken(state.token);
    save();
  }

  /** 开始扫码登录：取二维码后后台轮询扫码状态，确认后自动保存凭据并启动收消息。 */
  async function beginLogin() {
    cancelLogin();
    emitStatus({ status: 'qrcode', qrcode: '', qrcodeImgContent: '' });
    let qr;
    try {
      qr = await ilink.getBotQrcode('3', state.token ? [state.token] : []);
    } catch (e) {
      emitStatus({ status: 'error', error: String(e?.message || e) });
      throw e;
    }
    loginState.qrcode = qr.qrcode || '';
    loginState.qrcodeImgContent = qr.qrcodeImgContent || '';
    emitStatus({ status: 'waiting' });

    loginAbort = new AbortController();
    const signal = loginAbort.signal;
    (async () => {
      const deadline = Date.now() + (config.loginTimeoutMs || 5 * 60_000);
      while (!disposed && !signal.aborted && Date.now() < deadline) {
        try {
          const res = await ilink.pollQrcodeStatus(loginState.qrcode, '', signal);
          if (res.status === 'confirmed' && res.botToken) {
            applyCredentials({
              token: res.botToken, botId: res.botId,
              baseUrl: res.baseUrl, userId: res.userId,
            });
            state.getUpdatesBuf = '';
            save();
            emitStatus({ status: 'ready', qrcode: '', qrcodeImgContent: '', error: '' });
            log('[transport] 扫码登录成功');
            startReceiveLoop();
            return;
          }
          if (res.status === 'expired' || res.status === 'canceled') {
            emitStatus({ status: 'expired', error: '二维码已失效，请重新扫码' });
            return;
          }
          emitStatus({ status: 'waiting' });
        } catch (e) {
          if (signal.aborted) return;
          log(`[transport] pollQrcodeStatus: ${e}`);
        }
      }
      if (!signal.aborted) emitStatus({ status: 'timeout', error: '扫码超时，请重新发起' });
    })();
    return getLoginState();
  }

  function cancelLogin() {
    if (loginAbort) { loginAbort.abort(); loginAbort = null; }
  }

  /** 后台长轮询收消息（每 35s 一次），游标持久化。 */
  function startReceiveLoop() {
    if (receiveAbort || disposed) return;
    if (!state.token) { emitStatus({ status: 'idle', error: '尚未扫码登录' }); return; }
    receiveAbort = new AbortController();
    const signal = receiveAbort.signal;
    (async () => {
      while (!disposed && !signal.aborted) {
        try {
          const res = await ilink.getUpdates(state.getUpdatesBuf, config.receiveLongPollMs || 35_000, signal);
          if (res.errcode === STALE_TOKEN_ERRCODE) {
            emitStatus({ status: 'stale-token', error: '微信登录已失效，请重新扫码' });
            return;
          }
          if (res.get_updates_buf) { state.getUpdatesBuf = res.get_updates_buf; save(); }
          for (const msg of res.msgs || []) {
            try { onMessage(msg); } catch (e) { log(`[transport] onMessage error: ${e}`); }
          }
        } catch (e) {
          if (signal.aborted) break;
          log(`[transport] getUpdates: ${e}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
  }

  function stopReceiveLoop() {
    if (receiveAbort) { receiveAbort.abort(); receiveAbort = null; }
  }

  /** 主动发送文本（审批卡/提醒/汇总/镜像）。typing 状态尽力而为。 */
  async function sendText(text, { contextToken, to } = {}) {
    if (!state.token) return { ok: false, error: '尚未扫码登录，无法发送微信消息' };
    const toUserId = to || state.userId;
    if (!toUserId) return { ok: false, error: '没有微信目标用户（请先扫码登录）' };
    const body = String(text ?? '').slice(0, 4000);
    if (!body) return { ok: false, error: 'empty' };

    let ticket = state.typingTicket;
    if (!ticket || Date.now() - state.typingTicketAt > 24 * 3600_000) {
      try {
        const cfg = await ilink.getConfig(toUserId, contextToken || '');
        ticket = cfg.typingTicket || '';
        if (ticket) { state.typingTicket = ticket; state.typingTicketAt = Date.now(); save(); }
      } catch (e) { log(`[transport] getConfig: ${e}`); }
    }
    try { if (ticket) await ilink.sendTyping(toUserId, ticket, 1); } catch { /* best effort */ }
    try {
      await ilink.sendMessage({ to: toUserId, text: body, contextToken });
      try { if (ticket) await ilink.sendTyping(toUserId, ticket, 2); } catch { /* best effort */ }
      return { ok: true, sent: true };
    } catch (e) {
      if (e?.errcode === STALE_TOKEN_ERRCODE) emitStatus({ status: 'stale-token', error: '微信登录已失效，请重新扫码' });
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /** 从微信消息里提取纯文本（复用协议层）。 */
  function messageText(msg) { return extractText(msg); }

  function start() {
    if (started || disposed) return;
    started = true;
    ilink.notifyStart?.();
    if (state.token) startReceiveLoop();
    log('[transport] started');
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelLogin();
    stopReceiveLoop();
    ilink.notifyStop?.();
    log('[transport] disposed');
  }

  return {
    getLoginState, beginLogin, cancelLogin, startReceiveLoop, stopReceiveLoop,
    sendText, messageText, start, dispose,
    get config() { return { ...config }; },
    get state() { return { ...state }; },
  };
}
