/**
 * dsh-plugin-wechat-session — SessionEventBridge + ApprovalGate（宿主侧核心）。
 *
 * 设计原则（去 dsh-im / 通道外设化）：
 *   - 插件不拥有会话、不创建会话；只做「会话引用者」。
 *   - SessionEventBridge：只读订阅 session/event，按用户显式绑定的会话前缀过滤，
 *     把 assistant 文本渲染到微信；不指定会话时只做只读镜像、不发送任何指令。
 *   - ApprovalGate：注册为 approval/request 的 waterfall 应答者。收到审批请求时，
 *     渲染成带会话前缀的微信卡片；用户在微信回复 <前缀>=<决策> 时，
 *     精确结算那一个请求（多请求并存不猜「最近一个」）。
 *   - 全部通过 DSH 官方 seam（ctx.on / ctx.effect / ctx.get）通信，
 *     不 import 任何 dsh-im 内部模块。
 *
 * 待决池机制移植自 dsh-feishu src/cards/interactions.ts（InteractionRegistry），
 * 在其上增加会话前缀寻址、超时提醒卡、permissionPreset 自动降级、定时汇总。
 */

const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];
const DECISION_ALIASES = {
  '1': 'allowed-once', 'y': 'allowed-once', 'yes': 'allowed-once', '允许': 'allowed-once', '批准': 'allowed-once',
  '0': 'rejected', 'n': 'rejected', 'no': 'rejected', '拒绝': 'rejected',
  'c': 'cancelled', '取消': 'cancelled',
};

/**
 * 把 DSH 底层抛出的英文错误中文化后再发到微信——用户看不懂英文。
 * 命中已知模式给中文；本身已是中文则原样保留；未知英文原文保留（不吞信息）。
 */
export function humanizeError(raw) {
  const msg = String(raw && raw.message ? raw.message : raw || '').trim();
  if (!msg) return '未知错误';
  // 已含中文：视为本地已包装好的提示，直接返回（截断防刷屏）。
  if (/[\u4e00-\u9fa5]/.test(msg)) return msg.slice(0, 160);
  const rules = [
    [/session\s+["'].*?["']\s+not found/i, '找不到该会话（可能已被删除或 ID 不对）'],
    [/\bsession\b.*\bnot found\b/i, '找不到该会话（可能已被删除或 ID 不对）'],
    [/\bnot found\b/i, '未找到对应对象'],
    [/cannot get property .*? without inject/i, '内部服务未就绪，请稍后重试'],
    [/\bunavailable\b/i, '服务暂不可用，请稍后重试'],
    [/bad[- ]?protocol/i, '链接格式无效'],
    [/\btimed?\s*out\b|\btimeout\b/i, '操作超时，请重试'],
    [/unauthori[sz]ed|forbidden|permission denied/i, '没有权限执行该操作'],
    [/invalid[- ]?json/i, '数据格式错误'],
    [/request[- ]?error/i, '请求失败，请重试'],
  ];
  for (const [re, cn] of rules) {
    if (re.test(msg)) return cn;
  }
  return msg.slice(0, 160);
}

/**
 * 从 sessionId 生成 4-6 位短前缀（默认 6）。
 * 跳过「session」这类对所有会话都相同的公共开头——真实会话 ID 多为
 * session-<uuid>，若直接取前 6 位会全部撞成「sessio」，多会话并行审批
 * 无法区分。跳过后取 UUID 段的前 N 位，区分度足够且仍简短易输入。
 */
const SESSION_PREFIX_COMMON_HEADS = ['session'];
export function sessionPrefix(sessionId, length = 6) {
  let s = String(sessionId || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  for (const head of SESSION_PREFIX_COMMON_HEADS) {
    // 仅当后面仍有足够区分内容时才跳过，避免把短 ID 削空/过短。
    if (s.startsWith(head) && s.length > head.length + 1) {
      s = s.slice(head.length);
      break;
    }
  }
  return s.slice(0, length);
}

/**
 * 解析微信入站指令：<前缀>=<决策> / <前缀> <决策> / /use <id> / /release / /list / /help
 * 返回 {kind, ...}，无法识别返回 {kind:'passthrough'}。
 */
export function parseInbound(text, { explicitSessions, prefixLength }) {
  const raw = String(text || '').trim();
  if (!raw) return { kind: 'passthrough' };

  // /new [可选标题]：薄创建新会话（在设置页指定的工作目录）。
  // 必须在 useLike 之前判断——/new 含斜杠不匹配纯 ID 正则，否则会被误判为 use-title。
  // 标题留空时用宿主侧固定的「微信 · Clawbot」。
  if (/^\/new(?:\s+.*)?$/i.test(raw)) {
    const nm = /^\/new\s+(.+?)\s*$/i.exec(raw);
    return { kind: 'new', title: nm ? nm[1].trim() : '' };
  }

  // /use <ID 或标题> 或中文「绑定 <ID 或标题>」。
  // 严格 ID（无空白、纯字母数字/点/下划线/冒号/连字符）直接绑定，保持向后兼容；
  // 其余（含中文、空格、· 的会话标题）返回 use-title，由宿主侧按标题反查 sessionId。
  const useLike = /^(?:\/use|绑定|bind)\s+(.+?)\s*$/i.exec(raw);
  if (useLike) {
    const arg = useLike[1].trim();
    if (/^[A-Za-z0-9._:\-]+$/.test(arg)) return { kind: 'use', sessionId: arg };
    return { kind: 'use-title', title: arg };
  }
  if (/^\/release\s*$/i.test(raw)) return { kind: 'release' };
  if (/^\/list\s*$/i.test(raw)) return { kind: 'list' };
  if (/^((\/help)|(\?))\s*$/i.test(raw)) return { kind: 'help' };

  // 选择题回复：<prefix> 1A 2B（数字+字母；字母=A/B/C 选项，多选如 1AB）。
  // 必须在审批决策之前识别：纯 1/0/c 是审批值，"数字+字母"才是选择题 token，
  // 两者互不重叠。仅当前缀匹配已绑定会话时才 claim。
  const qr = /^([a-z0-9]{4,6})\s+((?:\d+[a-z]+\s*)+)$/i.exec(raw);
  if (qr) {
    const prefix = qr[1].toLowerCase();
    const tokens = qr[2].trim().split(/\s+/).map((t) => {
      const mm = /^(\d+)([a-z]+)$/i.exec(t);
      return mm ? { index: parseInt(mm[1], 10), letters: mm[2].toUpperCase() } : null;
    }).filter(Boolean);
    if (tokens.length) {
      const sessionId = explicitSessions.find((id) => {
        const p = sessionPrefix(id, prefixLength);
        return p === prefix || p.startsWith(prefix);
      });
      if (sessionId) return { kind: 'question-reply', sessionId, prefix, tokens };
    }
  }

  // 决策：<prefix>=<value> 或 <prefix> <value>
  const m = /^([a-z0-9]{4,6})\s*[=:]\s*(\S+)$/i.exec(raw)
    || /^([a-z0-9]{4,6})\s+(\S+)$/i.exec(raw);
  if (m) {
    const prefix = m[1].toLowerCase();
    const value = m[2];
    const outcome = DECISION_ALIASES[value.toLowerCase()] || (APPROVAL_OUTCOMES.includes(value) ? value : null);
    // 仅当前缀匹配某个已绑定会话时才 claim，否则交回（避免误吞普通聊天）。
    const sessionId = explicitSessions.find((id) => sessionPrefix(id, prefixLength).startsWith(prefix) || sessionPrefix(id, prefixLength) === prefix);
    if (sessionId && outcome) return { kind: 'decision', sessionId, outcome, prefix };
    if (sessionId && !outcome) return { kind: 'bad-decision', sessionId, prefix, value };
    if (!sessionId && outcome) return { kind: 'unknown-prefix', prefix };
  }
  return { kind: 'passthrough' };
}

/**
 * 待决审批注册表：每个请求一个条目，幂等结算（settle 只生效一次），
 * 超时可发提醒卡（最多 N 次）、可按 permissionPreset 自动降级。
 *
 * 条目：{id, sessionId, prefix, chatId, resolve, timer, remindTimer, remindCount, state, meta}
 */
export class ApprovalRegistry {
  constructor(opts = {}) {
    this.pending = new Map();
    this.log = opts.log || (() => {});
    this.prefixLength = opts.prefixLength || 6;
    this.remindIntervalMs = opts.remindIntervalMs || 60_000;
    this.maxReminders = opts.maxReminders ?? 3;
    this.permissionPreset = opts.permissionPreset || 'ask'; // ask | allow-once | reject
    this.onRemind = opts.onRemind || (() => {});
    this.onSummary = opts.onSummary || (() => {});
  }

  /** 注册一个审批请求，返回 settle(outcome)（幂等）。 */
  register({ id, sessionId, chatId, meta, timeoutMs, onSettle }) {
    this.abort(id, 'replaced');
    const prefix = sessionPrefix(sessionId, this.prefixLength);
    let done = false;
    const entry = {
      id, sessionId, prefix, chatId, meta, resolve: null, timer: null,
      remindTimer: null, remindCount: 0, done: false,
    };
    const settle = (outcome) => {
      if (done) return false;
      done = true;
      entry.done = true;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.remindTimer) clearInterval(entry.remindTimer);
      this.pending.delete(id);
      this.log(`[approval] settle ${id} -> ${outcome} (session ${prefix})`);
      onSettle(outcome);
      return true;
    };
    entry.resolve = settle;
    this.pending.set(id, entry);

    const fallback = this.permissionPreset === 'allow-once' ? 'allowed-once'
      : this.permissionPreset === 'reject' ? 'rejected' : 'cancelled';

    // 硬上限超时：无论如何到点后按 permissionPreset 自动降级（ask → cancelled）。
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        this.log(`[approval] timeout ${id} -> ${fallback} (preset=${this.permissionPreset})`);
        settle(fallback);
      }, timeoutMs);
      entry.timer.unref?.();
    }
    // 延迟提醒：每 remindIntervalMs 发一次提醒卡；达到 maxReminders 次后自动降级结算。
    if (this.maxReminders > 0 && this.remindIntervalMs > 0) {
      entry.remindTimer = setInterval(() => {
        if (entry.remindCount >= this.maxReminders) {
          clearInterval(entry.remindTimer);
          entry.remindTimer = null;
          this.log(`[approval] reminders exhausted ${id} -> ${fallback}`);
          settle(fallback);
          return;
        }
        entry.remindCount += 1;
        this.log(`[approval] remind ${id} #${entry.remindCount} (session ${prefix})`);
        Promise.resolve(this.onRemind(entry)).catch((e) => this.log(`[approval] remind error: ${e}`));
      }, this.remindIntervalMs);
      entry.remindTimer.unref?.();
    }
    return settle;
  }

  /** 按会话前缀 + 决策结算；多请求并存时只结算该会话的那个（最旧一个）。 */
  resolveByPrefix(prefix, outcome) {
    const p = String(prefix || '').toLowerCase();
    for (const entry of this.pending.values()) {
      if (entry.prefix === p || entry.prefix.startsWith(p)) {
        this.log(`[approval] resolveByPrefix ${p} -> ${outcome} (id ${entry.id})`);
        return entry.resolve(outcome);
      }
    }
    return false;
  }

  /** 精确按 id 结算（用于卡片回调等）。 */
  resolveById(id, outcome) {
    const entry = this.pending.get(id);
    return entry ? entry.resolve(outcome) : false;
  }

  abort(id, outcome = 'cancelled') {
    const entry = this.pending.get(id);
    return entry ? entry.resolve(outcome) : false;
  }

  has(id) { return this.pending.has(id); }
  size() { return this.pending.size; }

  /** 未决汇总快照（供 /list 与定时汇总）。 */
  snapshot() {
    return Array.from(this.pending.values()).map((e) => ({
      id: e.id, prefix: e.prefix, sessionId: e.sessionId, meta: e.meta,
      remindCount: e.remindCount,
    }));
  }

  /** 定时汇总回调：把当前未决清单交给 onSummary。 */
  fireSummary() {
    const rows = this.snapshot();
    if (rows.length) Promise.resolve(this.onSummary(rows)).catch((e) => this.log(`[approval] summary error: ${e}`));
  }

  dispose() {
    for (const entry of Array.from(this.pending.values())) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.remindTimer) clearInterval(entry.remindTimer);
      entry.resolve('cancelled');
    }
    this.pending.clear();
  }
}

/**
 * 创建宿主侧 bridge 实例。调用方（lib/index.js 的 apply）负责：
 *   - 把 createBridge 返回的 handlers 挂到 ctx.on('approval/request' / 'session/event')
 *   - 把微信入站消息交给 bridge.handleInbound(text)
 *   - 把微信 sendText 函数注入 opts.send（签名 async (text) => void）
 */
export function createBridge(opts = {}) {
  const log = opts.log || (() => {});
  const send = opts.send || (async () => {});
  const config = opts.config || {};
  // 自由对话投递器：由宿主侧注入（内部走 ctx.sessionController.prompt）。
  // 不传时对话功能不可用，但 /use、审批、事件投递等现有功能完全不受影响。
  const submitPrompt = typeof opts.submitPrompt === 'function' ? opts.submitPrompt : null;
  // 按会话标题反查 sessionId：由宿主侧注入（内部走 sessionController.list +
  // sessionQuery.readTitle）。签名 async (title) =>
  //   { ok:true, sessionId, title } | { ok:false, matches:[{sessionId,title}] } | { ok:false, error }
  // 不传时「绑定 <标题>」会给出不可用提示，但全 ID 绑定与其余功能不受影响。
  const resolveSessionByTitle = typeof opts.resolveSessionByTitle === 'function' ? opts.resolveSessionByTitle : null;
  const resolveSessionByPrefix = typeof opts.resolveSessionByPrefix === 'function' ? opts.resolveSessionByPrefix : null;
  // 薄创建新会话：由宿主侧注入（内部走 sessionController.create + rename）。
  // 签名 async (title) => { ok:true, sessionId, title } | { ok:false, error }。
  // 只创建后立即当绑定目标，不维护会话池/清理/映射——权威仍在 DSH。
  const createSession = typeof opts.createSession === 'function' ? opts.createSession : null;
  // 新建会话的默认标题（设置页可配，宿主侧兜底固定值）。
  const newSessionTitle = String(config.newSessionTitle || '微信 · Clawbot');
  // 会话标题读取器：由宿主侧注入（内部走 sessionQuery.readTitle）。签名 async (sessionId) => string。
  // 正文镜像用它渲染「DeepSeek Harness · 会话「标题」」抬头；取不到时退回短前缀。
  // 不传时正文抬头退化为短前缀，其余功能不受影响。
  const sessionTitle = typeof opts.sessionTitle === 'function' ? opts.sessionTitle : null;
  // 正文镜像抬头：用户看不懂短码，改用可读的会话标题行。不缓存——标题可能被 DSH 自动改写。
  async function bodyHeader(id) {
    let title = '';
    if (sessionTitle) {
      try { title = String(await sessionTitle(id) || '').trim(); } catch (e) { title = ''; }
    }
    return `DeepSeek Harness · 会话「${title || sessionPrefix(id, prefixLength)}」\n`;
  }
  // 发送正文镜像（异步解析抬头后投递）。
  function sendBody(id, text) {
    bodyHeader(id).then((header) => {
      send(`${header}${text}`).catch((e) => log(`[bridge] body send error: ${e}`));
    }).catch((e) => log(`[bridge] body header error: ${e}`));
  }
  // 绑定状态持久化：由宿主侧注入 { load(): {sessions,activeSession}, save(data) }。
  // 不传时退化为纯内存（原有行为，smoke 旧用例无需改动）。
  const bindingStore = opts.bindingStore && typeof opts.bindingStore.load === 'function'
    ? opts.bindingStore
    : null;
  const explicitSessions = new Set(); // 用户显式绑定的会话 ID
  let activeSession = null;           // 最近 /use 绑定的会话，作为自由对话的目标
  // 启动恢复：把上次持久化的绑定集合与活跃会话读回内存。
  if (bindingStore) {
    try {
      const restored = bindingStore.load() || {};
      for (const sid of (Array.isArray(restored.sessions) ? restored.sessions : [])) {
        if (typeof sid === 'string' && sid) explicitSessions.add(sid);
      }
      // 活跃会话必须是仍被绑定的会话，避免不一致。
      activeSession = (typeof restored.activeSession === 'string' && explicitSessions.has(restored.activeSession))
        ? restored.activeSession
        : null;
    } catch (e) { log(`[bridge] 绑定状态恢复失败: ${e}`); }
  }
  function persistBindings() {
    if (!bindingStore) return;
    try {
      bindingStore.save({ sessions: Array.from(explicitSessions), activeSession });
    } catch (e) { log(`[bridge] 绑定状态保存失败: ${e}`); }
  }
  const prefixLength = config.prefixLength || 6;
  // 回填窗口要覆盖「浮层 60s 超时 → 富格式卡到微信 → 用户回填」整段，默认 5 分钟。
  const approvalTimeoutMs = config.approvalTimeoutMs || 300_000;
  const mentionAll = config.sessionEventMentions !== false;
  // live 模型输出聚合缓冲：dsh 0.1.5 起正文走 agent/assistant-stream，不再进
  // session/event 的 event log。按 sessionId|attemptId 聚合 text-delta，end 时一次性
  // 投递微信，避免逐分片刷屏。key = `${sessionId}|${attemptId}`。
  const streamBuffers = new Map();
  // 选择题待决：key = sessionId（同一会话并发选择题时后到覆盖先到，与审批一致）。
  // entry = { id, sessionId, prefix, questions, callId, agent, resolve, timer, done }
  const questionPending = new Map();

  const registry = new ApprovalRegistry({
    log, prefixLength,
    remindIntervalMs: config.remindIntervalMs || 60_000,
    maxReminders: config.maxReminders ?? 3,
    permissionPreset: config.permissionPreset || 'ask',
    onRemind: (entry) => send(`[提醒] 审批仍待处理 [${entry.prefix}] ${entry.meta?.toolName || '工具调用'} — 回复 ${entry.prefix}=1 批准 / ${entry.prefix}=0 拒绝`),
    onSummary: (rows) => send(`[未决汇总] 共 ${rows.length} 条：\n` + rows.map((r) => `[${r.prefix}] ${r.meta?.toolName || '工具调用'}`).join('\n')),
  });

  // 定时汇总（可配置，默认关闭；>0 时每 interval 汇总一次）。
  let summaryTimer = null;
  if (config.summaryIntervalMs > 0) {
    summaryTimer = setInterval(() => registry.fireSummary(), config.summaryIntervalMs);
    summaryTimer.unref?.();
  }

  function bindSession(sessionId) {
    if (!sessionId) return false;
    explicitSessions.add(sessionId);
    activeSession = sessionId; // /use 即设为对话目标
    persistBindings();
    return true;
  }
  function releaseAll() {
    const n = explicitSessions.size;
    explicitSessions.clear();
    activeSession = null;
    persistBindings();
    return n;
  }
  function boundList() { return Array.from(explicitSessions); }

  /** SessionEventBridge：只读订阅 session/event（由 index.js 挂 ctx.on）。 */
  function onSessionEvent(session, event) {
    const id = session?.id || event?.sessionId;
    if (!id || explicitSessions.size === 0) return; // 未绑定任何会话 → 只读镜像，不投递
    if (!explicitSessions.has(id)) return;           // 非绑定会话 → 忽略
    if (!mentionAll) return;
    // 正文类事件（assistant/message 最终回复、assistant/attempt 中间播报）统一由
    // onAssistantStream 处理：那里按 attempt 的 end outcome 精确区分，只投递最终回复。
    // session/event 是 post-commit 的 durable append feed，同样会 append 这些事件，
    // 若在这里再投递会重复（message）或漏出中间播报（attempt），因此一律跳过。
    const eventType = String(event?.type || event?.kind || '');
    if (eventType.startsWith('assistant/')) return;
    // 只呈现其它关键事件，避免刷屏。
    const text = extractEventText(event);
    if (text) {
      // 正文镜像用可读标题抬头（用户看不懂短码），不用 [前缀]。
      sendBody(id, text);
    }
  }

  /**
   * live 模型输出订阅（由 index.js 挂 ctx.on('agent/assistant-stream')）。
   * dsh 0.1.5 起正文离开 session/event log，改走这里的帧：
   *   { type:'start'|'chunk'|'end', attemptId, revision, chunk?:{type:'text-delta', text} }
   * 只处理显式绑定会话；chunk 的 text-delta 追加到缓冲，end 时一次性投递微信。
   */
  function onAssistantStream(payload) {
    const agent = payload?.agent || payload;
    const id = agent?.session?.id || payload?.sessionId;
    if (!id || explicitSessions.size === 0) return;
    if (!explicitSessions.has(id)) return;
    const frame = payload?.frame || payload;
    const type = frame?.type;
    if (!type) return;
    const attemptKey = `${id}|${String(frame.attemptId ?? 'default')}`;
    if (type === 'start') {
      // 新 attempt：重置缓冲（revision 回退场景也从这里重新起）
      streamBuffers.set(attemptKey, { text: '', revision: frame.revision || 0 });
      return;
    }
    let buf = streamBuffers.get(attemptKey);
    if (!buf) { buf = { text: '', revision: 0 }; streamBuffers.set(attemptKey, buf); }
    // 丢弃乱序/迟到的旧 revision 分片
    if (typeof frame.revision === 'number' && frame.revision < buf.revision) return;
    if (typeof frame.revision === 'number') buf.revision = frame.revision;
    if (type === 'chunk') {
      const chunk = frame.chunk;
      // 只取正文 text-delta，跳过 reasoning-delta（思考过程不投递）与工具片段
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        buf.text += chunk.text;
      }
      return;
    }
    if (type === 'end') {
      streamBuffers.delete(attemptKey);
      // 一个 turn 可能有多个 attempt：工具循环里的中间播报以 assistant/attempt 结算，
      // 被取消的以 abandoned 结算，只有最终回复以 assistant/message 结算。
      // 用户只要最后的回复，中间播报/放弃的 attempt 一律不投递微信。
      const outcome = frame.outcome;
      if (!outcome || outcome.kind !== 'committed' || outcome.eventType !== 'assistant/message') return;
      const text = String(buf.text || '').trim();
      if (!text) return;
      // 正文镜像用可读标题抬头（用户看不懂短码），不用 [前缀]。
      sendBody(id, text.slice(0, 1800));
    }
  }

  /** ApprovalGate：注册为 approval/request waterfall 应答者。
   *  asar 实证：ctx.approval 无「按 callId 事后回填」接口，审批决策只能由应答者在此刻返回。
   *  原生 UI 也是「注册应答者 + await 点击」，故要走 official waterfall 竞答：
   *    - 任意会话（含未 /use 绑定）都注册待决，让微信回「前缀=1/0/c」能结算；
   *    - 绑定会话保持原有「微信独占」行为（不调 next，避免回归「微信只要一套卡」）；
   *    - 未绑定会话调 next() 让原生 UI 应答器正常显示，与微信回填竞答，谁先谁生效。
   */
  async function onApprovalRequest(request, next) {
    const agent = request?.agent;
    const sessionId = agent?.session?.id || request?.sessionId || '';
    if (!sessionId) return typeof next === 'function' ? next() : undefined;
    const bound = explicitSessions.has(sessionId);
    const prefix = sessionPrefix(sessionId, prefixLength);
    const id = String(request?.callId || request?.id || `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const toolName = String(request?.toolName || request?.tool || '工具调用');
    const reason = request?.reason ? String(request.reason).slice(0, 400) : '';

    const decision = new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      // 不再即时发「[审批请求]」短卡：微信侧唯一的审批交互卡由 client 半边在浮层
      // 超时后发富格式卡，这里只保留待决注册，等用户按卡里的前缀回填（resolveByPrefix）。
      registry.register({
        id, sessionId, chatId: opts.chatId || '', prefix,
        meta: { toolName, callId: request?.callId },
        timeoutMs: approvalTimeoutMs,
        onSettle: finish,
      });
      // 请求被外部取消时立即结算。
      request?.signal?.addEventListener?.('abort', () => registry.abort(id, 'cancelled'), { once: true });
    });

    // 绑定会话：保持微信独占，claim 住不交回下一个应答者。
    if (bound || typeof next !== 'function') return decision;
    // 未绑定会话：与原生 UI 应答器竞答。先记下待决前缀，方便微信回填；
    // next() 触发下游（原生 UI）建卡等待点击，谁先 settle 谁定案。
    try {
      const ui = Promise.resolve().then(() => next());
      const winner = await Promise.race([
        decision.then((o) => ({ outcome: o, from: 'wechat' })),
        ui.then((o) => ({ outcome: o, from: 'ui' })),
      ]);
      if (winner.from === 'ui') registry.abort(id, 'cancelled'); // UI 先答：撤销微信待决，幂等
      return winner.outcome;
    } catch (e) {
      // 下游应答器抛错时退回微信决策（fail-closed 仍是本插件的职责）。
      return decision;
    }
  }

  /**
   * 选择问题的能力答者：注册为 user-questions/request waterfall 应答者。
   * 回调返回的 AskUserQuestionAnswer 即回填值（与审批 waterfall 对称）。
   * 只处理未绑定会话的跳过（不 claim）；带 intent（approval/plan-review）的
   * 请求是审批语义，跳过交回给原生应答者，避免与 ApprovalGate 冲突。
   */
  async function onUserQuestions(request, next) {
    const agent = request?.agent;
    const sessionId = agent?.session?.id || request?.sessionId || '';
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    if (!sessionId || !questions.length) return typeof next === 'function' ? next() : undefined;
    // 带 intent 的题本质是审批/计划审阅，交给 approval 链路，不在这里 claim。
    if (questions.some((q) => q && q.intent)) return typeof next === 'function' ? next() : undefined;

    const bound = explicitSessions.has(sessionId);
    const prefix = sessionPrefix(sessionId, prefixLength);
    const callId = String(request?.wait?.callId || request?.callId || `${sessionId}-${Date.now()}`);
    const emptyAnswer = () => ({ answers: questions.map((q) => ({ id: String(q?.id || ''), selected: [] })) });

    const decision = new Promise((resolve) => {
      let settled = false;
      const finish = (answer) => {
        if (settled) return false;
        settled = true;
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
        questionPending.delete(sessionId);
        resolve(answer);
        return true;
      };
      const entry = { id: callId, sessionId, prefix, questions, callId, agent, timer: null, resolve: finish, done: false };

      // 不再即时发「[需要选择]」短卡：微信侧唯一的选择交互卡由 client 半边在浮层
      // 超时后发富格式卡（选项已改成 A/B/C，脚注写明回填码）。这里只保留待决注册，
      // 等用户按卡里的前缀回填（handleInbound 的 question-reply 分支 → resolveQuestions）。
      questionPending.set(sessionId, entry);
      // 硬超时：到点回填空答案（交给调用方 fail-closed），并提示用户已超时。
      const timeoutMs = config.questionTimeoutMs || approvalTimeoutMs;
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          log(`[user-questions] timeout ${callId} (session ${prefix})`);
          send(`[${prefix}] 选择题已超时，未收到回复。`).catch(() => {});
          finish(emptyAnswer());
        }, timeoutMs);
        entry.timer.unref?.();
      }
      request?.signal?.addEventListener?.('abort', () => finish(emptyAnswer()), { once: true });
    });

    // 绑定会话：保持微信独占（不调 next）。
    if (bound || typeof next !== 'function') return decision;
    // 未绑定会话：与原生 UI 选择题应答器竞答，谁先 settle 谁定案。
    try {
      const ui = Promise.resolve().then(() => next());
      const winner = await Promise.race([
        decision.then((a) => ({ answer: a, from: 'wechat' })),
        ui.then((a) => ({ answer: a, from: 'ui' })),
      ]);
      if (winner.from === 'ui') {
        // UI 先答：撤销微信待决（幂等），清掉超时定时器避免残留提示。
        const entry = questionPending.get(sessionId);
        if (entry && entry.id === callId && entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
        questionPending.delete(sessionId);
      }
      return winner.answer;
    } catch (e) {
      return decision;
    }
  }

  /** 把微信回复的选择 token 映射成 AskUserQuestionAnswer 并结算对应会话的待决题。 */
  function resolveQuestions(sessionId, tokens) {
    const entry = questionPending.get(sessionId);
    if (!entry) return false;
    const selectedByIndex = new Map();
    for (const tk of tokens) {
      const q = entry.questions[tk.index - 1];
      if (!q) continue;
      const opts = Array.isArray(q.options) ? q.options : [];
      const labels = [];
      for (const ch of tk.letters) {
        const oi = ch.charCodeAt(0) - 65;
        if (oi >= 0 && oi < opts.length) labels.push(String(opts[oi].label || ''));
      }
      if (labels.length) selectedByIndex.set(tk.index - 1, labels);
    }
    const answer = {
      answers: entry.questions.map((q, qi) => ({
        id: String(q?.id || ''),
        selected: selectedByIndex.get(qi) || [],
      })),
    };
    return entry.resolve(answer);
  }

  /** 微信入站消息总入口：先解析指令，再路由到对应 seam。 */
  /** 待决会话 ID 集合：已绑定 + 审批/选择题待决池里的会话。
   *  富格式卡由 client 半边对所有会话发（浮层超时即推微信），回填前缀必须能命中
   *  那些「发过卡但未 /use 绑定」的会话，否则会掉进自由对话分支误投。 */
  function resolvableSessions() {
    const ids = new Set(boundList());
    for (const e of registry.pending.values()) if (e.sessionId) ids.add(e.sessionId);
    for (const sid of questionPending.keys()) if (sid) ids.add(sid);
    return Array.from(ids);
  }

  async function handleInbound(text) {
    const parsed = parseInbound(text, { explicitSessions: resolvableSessions(), prefixLength });
    switch (parsed.kind) {
      case 'new': {
        if (!createSession) {
          await send('新建会话暂不可用：宿主未提供 sessionController.create。');
          return { handled: true, action: 'new-unavailable' };
        }
        const title = parsed.title || newSessionTitle;
        let created;
        try {
          created = await createSession(title);
        } catch (e) {
          log(`[bridge] createSession error: ${e}`);
          await send(`新建会话失败：${humanizeError(e)}`);
          return { handled: true, action: 'new-error', error: String(e?.message || e) };
        }
        if (!created || !created.ok || !created.sessionId) {
          await send(`新建会话失败：${humanizeError(created?.error || '未知错误')}`);
          return { handled: true, action: 'new-error', error: created?.error };
        }
        // 创建后立即作为绑定目标（薄创建：不维护会话池）。
        bindSession(created.sessionId);
        await send(`已新建会话「${created.title || title}」（${created.sessionId}，前缀 ${sessionPrefix(created.sessionId, prefixLength)}）并绑定。现在可直接发消息开始对话。`);
        return { handled: true, action: 'new', sessionId: created.sessionId, title: created.title || title };
      }
      case 'use': {
        // 卡片里给的是短前缀（/use <前缀>），需反查成完整 sessionId 再绑定；
        // 反查不到（或未注入解析器）则回退字面绑定，保持完整 ID 兼容。
        let sid = parsed.sessionId;
        let byPrefix = false;
        if (resolveSessionByPrefix) {
          try {
            const resolved = await resolveSessionByPrefix(parsed.sessionId);
            if (resolved && resolved.ok && resolved.sessionId) {
              sid = resolved.sessionId;
              byPrefix = true;
            }
          } catch (e) { /* 反查失败回退字面绑定 */ }
        }
        bindSession(sid);
        await send(`已绑定会话 ${sid}（前缀 ${sessionPrefix(sid, prefixLength)}）${byPrefix ? '（按前缀匹配）' : ''}。该会话的审批与事件将投递到微信。`);
        return { handled: true, action: 'use', sessionId: sid };
      }
      case 'use-title': {
        // 按标题短名绑定：先经宿主解析成唯一 sessionId，再走同一绑定路径。
        if (!resolveSessionByTitle) {
          await send('按标题绑定暂不可用，请改用 /use <完整会话ID>。');
          return { handled: true, action: 'use-title-unavailable' };
        }
        let resolved;
        try {
          resolved = await resolveSessionByTitle(parsed.title);
        } catch (e) {
          log(`[bridge] resolveSessionByTitle error: ${e}`);
          await send(`按标题「${parsed.title}」解析失败：${humanizeError(e)}`);
          return { handled: true, action: 'use-title-error', error: humanizeError(e) };
        }
        if (!resolved || !resolved.ok) {
          if (resolved && Array.isArray(resolved.matches) && resolved.matches.length) {
            const list = resolved.matches.slice(0, 8).map((m) => `· ${m.title} → ${sessionPrefix(m.sessionId, prefixLength)}（${m.sessionId}）`).join('\n');
            await send(`标题「${parsed.title}」匹配到多个会话，请用更精确的关键字，或直接用前缀/完整 ID 绑定：\n${list}`);
            return { handled: true, action: 'use-title-ambiguous', matches: resolved.matches };
          }
          await send(`未找到标题含「${parsed.title}」的会话。可发 /list 查看已绑定，或用 /use <完整会话ID>。`);
          return { handled: true, action: 'use-title-notfound' };
        }
        bindSession(resolved.sessionId);
        await send(`已按标题「${resolved.title || parsed.title}」绑定会话 ${resolved.sessionId}（前缀 ${sessionPrefix(resolved.sessionId, prefixLength)}）。该会话的审批与事件将投递到微信。`);
        return { handled: true, action: 'use-title', sessionId: resolved.sessionId, title: resolved.title };
      }
      case 'release': {
        const n = releaseAll();
        await send(`已释放全部会话绑定（共 ${n} 个）。`);
        return { handled: true, action: 'release', count: n };
      }
      case 'list': {
        const rows = boundList();
        const pending = registry.snapshot();
        await send(rows.length
          ? `已绑定会话：\n${rows.map((id) => `[${sessionPrefix(id, prefixLength)}] ${id}`).join('\n')}\n未决审批：${pending.length} 条`
          : '当前未绑定任何会话。发送 /use <会话ID> 绑定。');
        return { handled: true, action: 'list' };
      }
      case 'help':
        await send('指令：/new [标题] 新建并绑定会话 · /use <会话ID> 或「绑定 <会话标题>」绑定会话 · /release 释放全部 · /list 查看绑定与未决 · <前缀>=1 批准 · <前缀>=0 拒绝 · <前缀>=c 取消 · 选择题回 <前缀> 1A 2B');
        return { handled: true, action: 'help' };
      case 'question-reply': {
        const ok = resolveQuestions(parsed.sessionId, parsed.tokens);
        await send(ok
          ? `已记录 [${parsed.prefix}] 的选择：${parsed.tokens.map((t) => t.index + t.letters).join(' ')}`
          : `前缀 ${parsed.prefix} 没有待决选择题（或已处理）。`);
        return { handled: true, action: 'question-reply', ok };
      }
      case 'decision': {
        const ok = registry.resolveByPrefix(parsed.prefix, parsed.outcome);
        await send(ok
          ? `已记录 [${parsed.prefix}] = ${parsed.outcome}`
          : `前缀 ${parsed.prefix} 没有待决请求（或已处理）。`);
        return { handled: true, action: 'decision', ok };
      }
      case 'bad-decision':
      case 'unknown-prefix':
        await send(`请使用 <会话前缀>=<决策> 格式，例如 ${parsed.prefix || '3f2a'}=1（批准）/ =0（拒绝）/ =c（取消）。`);
        return { handled: true, action: 'bad-decision' };
      default: {
        // 自由对话：普通聊天文本投给最近 /use 绑定的固定会话。
        // 走宿主注入的 submitPrompt（内部 ctx.sessionController.prompt）；agent 回复
        // 由现有 onSessionEvent 镜像回微信，构成完整回路。
        const body = String(text || '').trim();
        if (!body) return { handled: false, action: 'passthrough' };
        if (!activeSession) {
          await send('尚未绑定会话，消息未转交。请先发送 /use <会话ID> 绑定。');
          return { handled: false, action: 'no-session' };
        }
        if (!submitPrompt) {
          return { handled: false, action: 'prompt-unavailable' };
        }
        const prefix = sessionPrefix(activeSession, prefixLength);
        try {
          const result = await submitPrompt(activeSession, body);
          if (result && result.accepted === false) {
            await send(`[${prefix}] 会话未接受消息：${humanizeError(result.error || '请稍后重试')}`);
            return { handled: true, action: 'prompt-rejected' };
          }
          // 不发「等待回复」回执：agent 正文经 agent/assistant-stream 镜像回来即是反馈，
          // 额外的中间提醒只会刷屏。失败分支仍用 prefix 给出明确错误。
          return { handled: true, action: 'prompt', sessionId: activeSession };
        } catch (e) {
          log(`[bridge] submitPrompt error: ${e}`);
          await send(`[${prefix}] 转交失败：${humanizeError(e)}`);
          return { handled: true, action: 'prompt-error', error: humanizeError(e) };
        }
      }
    }
  }

  function extractEventText(event) {
    if (!event) return '';
    // session/event 的 event 结构随类型不同；取常见的文本字段。
    const kind = event.kind || event.type || '';
    if (kind && !/assistant|message|turn|text|answer|result/i.test(String(kind))) return '';
    const body = event.text ?? event.content ?? event.message ?? event.delta ?? '';
    if (typeof body === 'string') return body.slice(0, 1000);
    if (body && typeof body === 'object') {
      const t = body.text || body.content || body.parts?.map?.((p) => p.text || '').join('');
      return typeof t === 'string' ? t.slice(0, 1000) : '';
    }
    return '';
  }

  function dispose() {
    registry.dispose();
    if (summaryTimer) clearInterval(summaryTimer);
    for (const entry of questionPending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ answers: entry.questions.map((q) => ({ id: String(q?.id || ''), selected: [] })) });
    }
    questionPending.clear();
    explicitSessions.clear();
    streamBuffers.clear();
  }

  return {
    onSessionEvent, onAssistantStream, onApprovalRequest, onUserQuestions, handleInbound, dispose,
    bindSession, releaseAll, boundList,
    registry, questionPending,
  };
}

export { APPROVAL_OUTCOMES, DECISION_ALIASES };
