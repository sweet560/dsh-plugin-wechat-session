// dsh-plugin-wechat-session — Client (browser) half.
//
// 触发源：DSH 0.2.2-rc.1 的 uiSession.sessionStatus
//   Map<sessionId, { running, pendingInteraction, completionUnread }>
// 它天然覆盖「全部会话」，不是只有当前打开的那一条。
// 当前正看着哪条会话，由 sessions 服务的 list 快照推导：
//   老宿主读 snapshot.current；0.1.6+ / 0.2.x 用 retainedBy.mainView > 0 的行
//   （照抄 dsh-notify-me 的 currentSessionId()，与宿主 DocumentTitle / ui-session 一致）。
// 三类事件：
//   ① 需要确认权限 / ② 需要手动选择 —— pendingInteraction 新出现
//      （kind: 'approval' | 'plan-review' | 'question'）
//   ③ 任务跑完 —— running true→false 且没有 pendingInteraction，
//      或 completionUnread 出现上升沿（模型这一轮回复结束）
//
// 提醒判据是「会话级」，不是「整个窗口级」（v1.3.0 修复多会话静音 bug）：
//   · 窗口在后台 / 人离开：所有会话都没在看，全部照常提醒（保留原「仅后台提醒」）。
//   · 窗口在前台：只有「不是当前正看着的那条」才提醒；当前那条保持安静
//     （用户决策：正盯着的会话不弹、不响、不计时）。
// 这样 3 条会话并行、界面停在 A 时，B / C 需要确认或跑完也会立即弹通知 + 提示音。
//
// 桌面提醒发出后开一个 30 秒批次。「已响应」也是会话级（用户决策）：
//   · 切到那条会话去看（它变成当前会话）
//   · 或把那条待办处理掉（pendingInteraction 消失）
// 30 秒内这两件事都没发生，就把仍未响应的条目汇总成一条微信发出去。
// 「回到窗口」不再单独算已响应——人本来就在窗口前时它根本不会触发。
// 三类都算 30 秒兜底（用户决策）。
// 微信经 Host half 的 /__dsh-plugin-wechat-session/wechat 交给 dsh-im（@xmanrui/dsh-im）
// 的主动投递服务，从微信机器人发到你指定的那一个微信目标。
// 不再经过 Server 酱，也不需要任何外部 Webhook / SendKey。
//
// v1.1.1：兼容把 dsh-im「复制调用参数」的整段 JSON 误粘进单个输入框，
// 自动拆回两个纯 ID；dsh-im 英文报错翻成中文。
// v1.3.0：会话级提醒 / 会话级「已响应」，修复多会话并行时其他会话不通知也不发微信。
// v1.5.0：三类事件（需要确认权限 / 需要手动选择 / 任务跑完）都弹「一张」
//   系统通知，格式对齐 dsh-pet 的卡片：标题「会话名 · 事件标签」，正文是
//   pendingInteraction 里抽出来的具体内容（问题文本 / 工具名+原因 / 回复摘要）。
//   标题措辞与 dsh-pet 一致（正在申请权限 / 模型在等你回答 / 任务跑完了），
//   取不到具体内容时回退成一句中文说明，不再是空洞的「DSH 需要你操作」。
//   用户决策：本插件弹，接受屏幕上同时出现本插件与 dsh-pet 两张相近卡片。
//   所有通知点击都跳到对应会话界面（v1.4.0 已实现，照抄 dsh-pet）：
//   uiWorkspace.openSession(sid) + window.focus() + Electron 的 dsh://open。
//   提示音与 30 秒微信兜底批次三类一律保留。
//
// 宿主契约写法照抄 _research/dsh-notify-me/package/lib/client.js（已在 0.2.2-rc.1
// 验证）与 DSH-better-sidebar-0.30.1/src/client/index.tsx。

(function (root) {
  if (!root) return;
  if (!root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;

  root.__ModuleLoader__.load({
    id: 'dsh-plugin-wechat-session',
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      // react 由 shell 预置，仅设置页用；拿不到就退化为不渲染设置页，核心不受影响。
      var React = null;
      try { React = require('react') || null; } catch (e) { React = null; }

      // ───────────────────────── 配置（localStorage） ─────────────────────────
      var LS_CONFIG = 'dshPluginWechatSession.config';
      // 改名迁移链（按 新 → 上一版 → 最旧 逐级回退）：
      //   dshPluginWechatSession.config  ← 本次改名 dsh-plugin-wechat-session（当前）
      //   dshSessionGuardian.config     ← 上一版 dsh-session-guardian（用户本机现在存的就是这个）
      //   dshWechatReminder.config      ← 更早在 v1.5.0 之前的 dsh-wechat-reminder
      // 本机改名重装后，若新 key 没值，就逐级回退读回已填的 Bot ID / 目标 ID，
      // 让用户不用重新填（旧 key 全部保留不清，避免误删）。
      var LS_CONFIG_PREV = 'dshSessionGuardian.config';
      var LS_CONFIG_OLD = 'dshWechatReminder.config';
      var DEFAULTS = {
        enabled: true,
        botId: '',            // dsh-im 微信机器人的 Bot ID（不透明字符串）
        targetId: '',         // 该机器人下指定的那一个微信目标 ID（稳定别名）
        timeoutSec: 30,       // 「任务跑完」类超时秒数（沿用旧行为）
        // m03992：需选择 / 确认权限 / 指导进入下一步这类「待拍板」事件单独一个
        // 超时，默认 60 秒（不是 30），与「任务跑完」分开。用户可在设置页改。
        attentionTimeoutSec: 60,
        sound: true,          // 提示音
        volume: 0.5,
        wechatEnabled: true,  // 超时后是否发微信
        notifyPermission: true,
      };

      // ───────────── ID 容错（v1.1.1） ─────────────
      // dsh-im 设置页「复制调用参数」给出的是一整段 JSON：
      //   {"botId":"wx_...","targetId":"tgt_..."}
      // 用户很自然会把它整段粘进单个输入框。dsh-im 只认纯 ID
      // （/^[A-Za-z0-9._:@-]{1,128}$/），整段会报 "Invalid target id"。
      // 这里自动把整段拆回两个纯 ID，用户不必手动裁切。
      function splitPair(raw) {
        if (typeof raw !== 'string') return null;
        var s = raw.trim();
        if (!s) return null;
        if (s.charAt(0) !== '{' && !/["']?(botId|targetId)["']?\s*[:=]/i.test(s)) return null;
        var botId = null, targetId = null;
        try {
          var obj = JSON.parse(s);
          if (obj && typeof obj === 'object') {
            for (var k in obj) {
              if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
              var v = obj[k];
              if (typeof v !== 'string' || !v.trim()) continue;
              var nk = k.toLowerCase().replace(/[\s_-]/g, '');
              if (nk === 'botid') botId = v.trim();
              else if (nk === 'targetid') targetId = v.trim();
            }
          }
        } catch (e) {
          // JSON 不合法时退化为正则抓取（容忍复制时夹带的换行 / 反引号 / 尾逗号）。
          var b = /["']?botId["']?\s*[:=]\s*["']([^"']+)["']/i.exec(s);
          var g = /["']?targetId["']?\s*[:=]\s*["']([^"']+)["']/i.exec(s);
          if (b) botId = b[1].trim();
          if (g) targetId = g[1].trim();
        }
        return botId || targetId ? { botId: botId, targetId: targetId } : null;
      }
      function normalizeIdPair(botId, targetId) {
        var b = typeof botId === 'string' ? botId.trim() : '';
        var g = typeof targetId === 'string' ? targetId.trim() : '';
        var pair = splitPair(b) || splitPair(g);
        if (pair) {
          if (pair.botId) b = pair.botId;
          if (pair.targetId) g = pair.targetId;
        }
        return { botId: b, targetId: g };
      }

      function readConfig() {
        var out = {};
        for (var k in DEFAULTS) out[k] = DEFAULTS[k];
        try {
          // 优先新 key；为空时按 上一版 → 最旧 逐级回退（改名重装后配置不丢）。
          var raw = root.localStorage && root.localStorage.getItem(LS_CONFIG);
          if (!raw && root.localStorage) raw = root.localStorage.getItem(LS_CONFIG_PREV);
          if (!raw && root.localStorage) raw = root.localStorage.getItem(LS_CONFIG_OLD);
          if (raw) {
            var saved = JSON.parse(raw);
            if (saved && typeof saved === 'object') {
              for (var key in DEFAULTS) {
                if (Object.prototype.hasOwnProperty.call(saved, key) && typeof saved[key] === typeof DEFAULTS[key]) {
                  out[key] = saved[key];
                }
              }
            }
          }
        } catch (e) {}
        if (out.timeoutSec < 5) out.timeoutSec = 5;
        if (out.timeoutSec > 3600) out.timeoutSec = 3600;
        // m03992：独立超时也夹到 5–3600，老配置没有这个字段时保持默认 60。
        if (out.attentionTimeoutSec < 5) out.attentionTimeoutSec = 5;
        if (out.attentionTimeoutSec > 3600) out.attentionTimeoutSec = 3600;
        out.volume = Math.max(0, Math.min(1, out.volume));
        // 已存进 localStorage 的整段 JSON 在这里自动洗成两个纯 ID（即时生效，
        // 老配置不用手动改）。
        var ids = normalizeIdPair(out.botId, out.targetId);
        out.botId = ids.botId;
        out.targetId = ids.targetId;
        return out;
      }

      var config = readConfig();

      function writeConfig(patch) {
        for (var k in patch) config[k] = patch[k];
        // 粘贴整段「复制调用参数」JSON 时，立刻拆成两个纯 ID 存起来，
        // 设置页输入框也会显示成拆开后的纯值。
        var ids = normalizeIdPair(config.botId, config.targetId);
        config.botId = ids.botId;
        config.targetId = ids.targetId;
        try {
          if (root.localStorage) root.localStorage.setItem(LS_CONFIG, JSON.stringify(config));
        } catch (e) {}
        try { (root.console || console).log('[dsh-plugin-wechat-session] 配置已保存'); } catch (e2) {}
      }

      // ───────────────────────── i18n 字典 ─────────────────────────
      // 用户偏好：所有展示内容一律中文。en 仅作发现基线 / 回退。
      var NS = 'dshPluginWechatSession';
      var UI_zh = {
        nav: '微信会话互通',
        title: '微信会话互通',
        masterSwitch: '启用本插件',
        masterHint: '关掉后不弹通知、不响提示音、不发微信。',
        botId: '微信机器人 Bot ID',
        botIdHint: '在 dsh-im「设置 → IM机器人」点微信机器人卡片齿轮复制 Bot ID（不透明字符串）。',
        targetId: '微信目标 ID',
        targetIdHint: '在 dsh-im 里给这个微信机器人新建目标后，点「复制调用参数」拿到 targetId。提醒永远发到这一个微信对话。直接把整段「复制调用参数」粘到上面任意一栏也行，会自动拆成两个 ID。两项都留空则只弹桌面通知，不发微信。',
        timeout: '任务跑完类超时（秒）',
        timeoutHint: '「任务跑完」这类事件，超过这个秒数没切过去看就发微信。',
        attentionTimeout: '需选择 / 确认类超时（秒）',
        attentionTimeoutHint: '「需要手动选择 / 确认权限 / 指导进入下一步」这类待拍板事件，超过这个秒数还没切进会话处理，就发一条极简微信提醒（哪条会话等你处理）。真正的「在微信里选」由 dsh-im 原生同步提问完成，绑定步骤见下方。默认 60 秒，与「任务跑完」分开。',
        sound: '提示音',
        soundHint: '弹通知的同时播放一段合成提示音。',
        wechat: '超时发微信',
        wechatHint: '关掉后只做桌面提醒，不补发微信。',
        volume: '音量',
        testDesktop: '测试桌面通知',
        testWechat: '测试微信推送',
        testDesktopOk: '已弹出右下角应用内浮层卡片并响提示音（点一下可跳到对应会话）。',
        testWechatSending: '正在发送测试微信…',
        testWechatOk: '已交给 dsh-im 微信机器人，请查看微信。',
        testWechatFail: '发送失败：',
        noKey: '还没填 Bot ID / 目标 ID。去 dsh-im「设置 → IM机器人」点目标卡片上的「复制调用参数」，把整段粘到上面任意一栏即可（会自动拆成两个 ID）。',
        saved: '已保存',
        // m05207：设置页「卡片式分组」用的短文案与分组标题。
        sectionHintShort: '只提醒你没在看的会话：右下角应用内浮层卡片（点一下跳过去）+ 提示音 + 超时极简微信留底。',
        detailsLabel: '展开完整说明',
        groupBasic: '基础',
        groupBot: '微信机器人 · 投递目标',
        groupTimeout: '超时设置',
        groupAlert: '提醒方式',
        groupWechat: '在微信里直接选择',
        groupTest: '测试',
        sectionHint: '多条会话并行时，只提醒你「没在看」的那些：正盯着的那条保持安静，其他会话需要确认、需要选择或任务跑完时，都弹一张带具体内容、点一下就能切到对应会话的应用内浮层卡片（右下角，不依赖系统通知权限，在别的会话界面也看得到）。「需选择 / 确认」与「任务跑完」各有独立超时（默认 60 / 30 秒，可在下面改），超时没切过去看 / 没把待办处理掉，就发一条极简微信提醒。若想直接在微信里回「1」选择并让任务继续，请按下方说明把当前会话绑定到已开启双向同步的微信私聊，选项卡由 dsh-im 原生同步提问推送并回填。你离开窗口时所有会话都提醒。',
        currentSession: '当前对话',
        kindApproval: '需要确认权限',
        kindQuestion: '需要手动选择',
        kindDone: '任务跑完了',
        wechatTitle: 'DSH 需要你看一下',
        wechatDoneTitle: 'DSH 任务已完成',
        wechatBody: '有 {n} 秒没切过去看这些会话、也没把待办处理掉：',
        wechatFooter: '切到对应会话查看或把待办处理掉，之后就不会再补发微信。',
        // m04774：微信只留「极简超时提醒」，不再把问题原文 / 编号选项 /
        // 回复格式 / 绑定长文拼成文字墙（用户实测太乱）。真正的「在微信里
        // 回 1 选择并让任务继续」由 dsh-im 原生同步提问完成，步骤见 wechatSyncGuide。
        wechatAttentionHead: '【等你处理】以下会话已等你 {n} 秒：',
        wechatDoneHead: '【已完成】以下会话这一轮已跑完：',
        wechatSession: '· 会话「{name}」· {event}',
        wechatDoneLine: '· 会话「{name}」已完成（{time}）',
        wechatAttentionFoot: '本条只是超时提醒，别在它下面回复；微信里直接选请用 dsh-im 推送的选项卡（绑定步骤见设置页）。',
        wechatFooterNew: '以上条目处理掉（回 DSH 点掉待办）后就不会再补发。',
        wechatSyncGuide: '【在微信里直接选 1 / 选 2，让任务继续】\n本插件自己发的微信收不到回复（微信渠道结构上不开放入站订阅），所以在那条提醒下回「1」不会回填；真正能回填的是 dsh-im 自带的「同步提问 / 远程审批」。\n① dsh-im 设置 →「通用设置 → 投递」打开双向同步（唯一开关）；\n② 在微信私聊里发 /sessionlist 查到当前会话 ID，再发 /session <会话ID> 把这个私聊绑定到当前会话；\n③ 之后会话一弹出选择 / 确认，dsh-im 会把带编号选项的选项卡推到该私聊，回「1」「选择 1」或「批准」即自动回填 DSH、任务继续。\n注意：那张选项卡是问题一出现就推，不是 60 秒超时后才推；本插件超时发的只是一条极简提醒留底，勿在那条下回复。',
        notifyApproval: '正在申请权限',
        notifyQuestion: '模型在等你回答',
        notifyDoneLabel: '对话完成',
        notifyBodyFallback: '点这条通知切到该会话查看具体内容；{n} 秒内没看会发微信。',
        notifyClickJump: '点击这条通知即可切到对应会话查看结果。',
      };
      var UI_en = {
        nav: 'WeChat Timeout Reminder',
        title: 'WeChat Timeout Reminder',
        masterSwitch: 'Enable plugin',
        masterHint: 'Turn off to mute desktop alerts and WeChat push.',
        botId: 'WeChat Bot ID',
        botIdHint: 'Copy the Bot ID from dsh-im IM bot settings.',
        targetId: 'WeChat Target ID',
        targetIdHint: 'Copy the targetId from dsh-im "copy call params" (or paste the whole JSON into either field to split automatically). Alerts always go to this one WeChat chat.',
        timeout: 'Task-finished timeout (seconds)',
        timeoutHint: 'For task-finished events, WeChat is sent if you do not visit the session within this many seconds.',
        attentionTimeout: 'Choice / approval timeout (seconds)',
        attentionTimeoutHint: 'For "choice / approval" events, after this many seconds without entering the session, a minimal WeChat reminder (which session is waiting) is sent. Truly choosing in WeChat is done by dsh-im native synced questions; see the binding guide below. Default 60s, separate from task-finished.',
        sound: 'Alert sound',
        soundHint: 'Play a synthesized cue together with the desktop notification.',
        wechat: 'WeChat on timeout',
        wechatHint: 'Turn off to keep desktop alerts only.',
        volume: 'Volume',
        testDesktop: 'Test desktop alert',
        testWechat: 'Test WeChat push',
        testDesktopOk: 'Raised the bottom-right in-app floating card and played a cue (click it to jump to the session).',
        testWechatSending: 'Sending test WeChat…',
        testWechatOk: 'Handed to dsh-im WeChat bot, check WeChat.',
        testWechatFail: 'Delivery failed: ',
        noKey: 'No Bot ID / Target ID configured yet.',
        saved: 'Saved',
        sectionHintShort: 'Only alerts for sessions you are not watching: a bottom-right in-app floating card (click to jump) + cue + a minimal WeChat fallback on timeout.',
        detailsLabel: 'Show full description',
        groupBasic: 'General',
        groupBot: 'WeChat bot & delivery target',
        groupTimeout: 'Timeouts',
        groupAlert: 'Alert channels',
        groupWechat: 'Answer directly in WeChat',
        groupTest: 'Test',
        sectionHint: 'With several sessions running, only the ones you are NOT looking at raise alerts; the session on screen stays quiet. Approval, question and task-finished all raise ONE in-app floating card with real content (bottom-right, visible from any session view, independent of OS notification permission); click it to jump to that session. "Choice / approval" and "task-finished" have separate timeouts (defaults 60 / 30 seconds, editable below); on timeout a minimal WeChat reminder is sent. To answer "1" directly in WeChat and let the task continue, bind the session to a two-way-synced WeChat private chat (see guide below); the option card is then pushed and backfilled by dsh-im native synced questions.',
        currentSession: 'Current conversation',
        kindApproval: 'Approval needed',
        kindQuestion: 'Your choice needed',
        kindDone: 'Task finished',
        wechatTitle: 'DSH needs you',
        wechatDoneTitle: 'DSH task finished',
        wechatBody: 'No visit / no action on these sessions for over {n}s:',
        wechatFooter: 'Switch to the session or clear its pending item to stop further WeChat alerts.',
        wechatAttentionHead: '[WAITING] These sessions have been waiting for you for {n}s:',
        wechatDoneHead: '[FINISHED] These sessions finished this round:',
        wechatSession: '· Session "{name}" · {event}',
        wechatDoneLine: '· Session "{name}" finished ({time})',
        wechatAttentionFoot: 'This is only a timeout reminder; do not reply under it. To choose in WeChat, use the option card pushed by dsh-im (binding steps in the settings page).',
        wechatFooterNew: 'Handled items (cleared in DSH) will not be pushed again.',
        wechatSyncGuide: '[Answer "1"/"2" directly in WeChat, let the task continue]\nWeChat replies to messages this plugin sends cannot be received (no inbound subscription for WeChat), so replying "1" under that reminder does NOT backfill. Real backfill is done by dsh-im native "synced questions / remote approval".\n① dsh-im Settings -> "General -> Delivery" enable two-way sync (the single switch);\n② In the WeChat private chat, send /sessionlist to find the current session ID, then /session <sessionID> to bind this chat to that session;\n③ Afterwards, whenever a choice/approval appears, dsh-im pushes a numbered option card to that chat; reply "1", "choose 1" or "approve" and it is written back into DSH so the task continues.\nNote: that card is pushed as soon as the question appears, not after the 60s timeout; the timeout message from this plugin is only a minimal fallback, do not reply under it.',
        notifyApproval: 'Requesting permission',
        notifyQuestion: 'Waiting for your answer',
        notifyDoneLabel: 'Conversation finished',
        notifyBodyFallback: 'Click this notification to open the session; WeChat follows in {n}s otherwise.',
        notifyClickJump: 'Click this notification to jump to the session.',
      };
      function t(key, vars) {
        var dict = UI_zh; // 一律中文
        var s = dict[key] != null ? dict[key] : (UI_en[key] != null ? UI_en[key] : key);
        if (vars) for (var v in vars) s = s.split('{' + v + '}').join(String(vars[v]));
        return s;
      }

      // ───────────────────────── 离开 / 回来判定 ─────────────────────────
      // 窗口是否整个在后台（人离开桌面 / 切到别的程序 / 最小化）。
      // v1.3.0：这只用于「后台时所有会话都算没在看」；前台时改用会话级判据。
      function isAway() {
        try {
          if (typeof document !== 'undefined') {
            if (document.hidden || document.visibilityState === 'hidden') return true;
            if (typeof document.hasFocus === 'function' && !document.hasFocus()) return true;
          }
        } catch (e) {}
        return false;
      }

      // ───────────────────── 会话级判定（v1.3.0） ─────────────────────
      // sessions.list 快照：老宿主有 current 字段；0.1.6+ / 0.2.x 靠
      // retainedBy.mainView > 0 标记「主视图正打开的那条」。照抄 dsh-notify-me
      // lib/client.js:2693-2705 的 currentSessionId()，与宿主 DocumentTitle /
      // ui-session.isMain() 同一套推导。
      var listStore = null;
      var listSub = null;
      function currentSessionId() {
        try {
          var st = listStore && listStore.getSnapshot();
          if (!st) return null;
          if (typeof st.current === 'string' && st.current) return st.current;
          var byId = st.byId || {};
          for (var id in byId) {
            var row = byId[id];
            if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id;
          }
        } catch (e) {}
        return null;
      }
      // 会话显示名：优先取 list 行的 displayTitle / title / label，让桌面通知
      // 和微信汇总能说清「哪条会话」；取不到再退回当前对话占位 / 原始 id。
      function sessionLabel(sid) {
        try {
          var st = listStore && listStore.getSnapshot();
          if (st && st.byId && st.byId[sid]) {
            var row = st.byId[sid];
            var name = row.displayTitle || row.title || row.label || '';
            if (name) return String(name).slice(0, 48);
          }
          if (currentSessionId() === sid) return t('currentSession');
        } catch (e) {}
        return String(sid || '会话').slice(0, 48);
      }
      // 是否应该为这条会话弹桌面提醒：
      //   · 窗口在后台 → 所有会话都没在看，全部提醒（保留「仅后台提醒」本意）；
      //   · 窗口在前台 → 只有「不是当前正看着的那条」才提醒。
      function shouldAlert(sid) {
        if (isAway()) return true;
        return !sid || sid !== currentSessionId();
      }

      // 是否属于「后台委托 / 子代理会话」：Mnemon「自进化」落盘任务、被
      // modsearch 调用的后台子代理等会创建这类会话，宿主会话列表本来就不显示
      // （dsh-client-ui-workspace.sessionVisible() 见到 origin==='subagent'
      // 直接 return false），不该再弹窗 / 响铃 / 发微信。
      // 判据与宿主一致（dsh-pet shouldNotifySession / dsh-rewind-plugin
      // isSubagentSession：origin==='subagent' 或 delegationDepth>0），外加
      // sessions.list 子代理行的 parentId，以及 dsh-mnemon 源码注释里声明
      // 「documented as stable」、供读 sessions 的插件排除用的委托任务标题前缀
      // "[dsh-mnemon:delegated " 兜底。数据源与本文件 currentSessionId() /
      // sessionLabel() 一样，都是 sessions.list 快照的 byId[sid] 行。
      function isIgnoredSession(sid) {
        try {
          var st = listStore && listStore.getSnapshot();
          var row = st && st.byId && sid ? st.byId[sid] : null;
          if (!row) return false;
          // sessions.list 行既有扁平字段（origin / delegationDepth / parentId），
          // 部分宿主也把同一组信息放在嵌套的 SessionHeader（dsh-pet 读的
          // 就是 session.header.origin）。两种形态都认，避免版本差异漏判。
          var hdr = row.header && typeof row.header === 'object' ? row.header : null;
          var origin = row.origin || (hdr && hdr.origin);
          var depth = typeof row.delegationDepth === 'number' ? row.delegationDepth
            : (hdr && hdr.delegationDepth);
          var parent = row.parentId || (hdr && (hdr.parentSession || hdr.parentId));
          var name = row.displayTitle || row.title || row.label
            || (hdr && (hdr.displayTitle || hdr.title)) || '';
          // ① 宿主会话列表的隐藏判据：子代理行不显示，也就不该提醒。
          if (origin === 'subagent') return true;
          // ② 委托深度 > 0：宿主 shouldNotifySession / isSubagentSession 的判据。
          if (typeof depth === 'number' && depth > 0) return true;
          // ③ 有父会话：子代理行由 subagentCatalog 投影生成时带 parentId。
          if (parent) return true;
          // ④ Mnemon 委托任务稳定前缀（DELEGATED_TASK_PREFIX）。即使宿主没带
          //    origin / parentId 标记也能兜底，且只命中 Mnemon 自己的子会话。
          if (typeof name === 'string' && name.indexOf('[dsh-mnemon:delegated ') === 0) return true;
        } catch (e) {}
        return false;
      }

      // ───────────────────────── 桌面通知 + 提示音 ─────────────────────────
      var audioCtx = null;
      // 统一日志出口：m03179 之前 toast / 权限 / 音频失败全被空 catch 吞掉，
      // 出问题看起来像「突发异常、无从排查」。现在成功、被拦、异常都留痕。
      function noteLog(level, msg) {
        try {
          var c = root.console || console;
          if (c && typeof c[level] === 'function') c[level]('[dsh-plugin-wechat-session] ' + msg);
        } catch (e) {}
      }
      // 每次提醒前都重试解锁音频：后台标签页里浏览器可能把 AudioContext
      // 挂起（state 变成 suspended/interrupted），旧版只在第一次手势里解锁，
      // 之后就再也 resume 不了，提示音于是永久静默。
      function unlockAudio() {
        try {
          if (!audioCtx) {
            var AC = root.AudioContext || root.webkitAudioContext;
            if (!AC) { noteLog('warn', '环境不支持 WebAudio，提示音改由系统通知音兜底'); return; }
            audioCtx = new AC();
          }
          if (audioCtx.state !== 'running') {
            var r = audioCtx.resume();
            if (r && typeof r.catch === 'function') r.catch(function () {});
          }
        } catch (e) {
          noteLog('error', '提示音解锁异常：' + (e && e.message ? e.message : String(e)));
        }
      }
      function tone(freq, startIn, durMs, vol) {
        if (!audioCtx || audioCtx.state !== 'running') return;
        try {
          var t0 = audioCtx.currentTime + startIn;
          var osc = audioCtx.createOscillator();
          var gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
          osc.connect(gain).connect(audioCtx.destination);
          osc.start(t0);
          osc.stop(t0 + durMs / 1000 + 0.05);
        } catch (e) {}
      }
      function playCue(isDone) {
        if (!config.sound) return;
        unlockAudio();
        var v = config.volume;
        if (isDone) {
          tone(659, 0.0, 150, v);
          tone(988, 0.18, 260, v);
        } else {
          tone(880, 0.0, 140, v);
          tone(1174, 0.16, 140, v);
          tone(1568, 0.32, 200, v);
        }
      }
      // 对齐 dsh-pet 的 initNotify/requestNotificationPermission：主动、可重试地
      // 申请通知权限。旧版只在「第一次用户手势」里申请一次、失败就永不重试；
      // DSH 每次重开端口会变 → 新 origin → 权限回到 default，窗口又在后台，
      // 于是桌面通知永久弹不出来（m03179 根因）。现在启动即申请、每次提醒前
      // 再确认，并把结果写日志，不再静默失败。
      var permissionPending = false;
      function ensurePermission() {
        try {
          if (typeof Notification === 'undefined') return;
          var p = Notification.permission;
          if (p === 'granted') return;
          if (p === 'denied') {
            noteLog('warn', '系统通知权限被拒绝（denied），桌面弹窗不可用，请到系统设置里允许 DSH 通知');
            return;
          }
          if (!config.notifyPermission || permissionPending) return;
          permissionPending = true;
          var req = Notification.requestPermission();
          Promise.resolve(req).then(
            function (res) {
              permissionPending = false;
              noteLog(res === 'granted' ? 'log' : 'warn', '通知权限申请结果：' + String(res));
            },
            function (err) {
              permissionPending = false;
              noteLog('error', '通知权限申请失败：' + (err && err.message ? err.message : String(err)));
            }
          );
        } catch (e) {
          permissionPending = false;
          noteLog('error', '通知权限申请异常：' + (e && e.message ? e.message : String(e)));
        }
      }
      var liveToasts = [];
      // 点击通知切到对应会话界面（照抄 dsh-pet lib/client.js:3431-3448 的
      // jumpToSession / wireNotificationClick）：
      //   · uiWorkspace.openSession(sid) 让宿主切到那条会话；旧版没有该服务就跳过；
      //   · window.focus() + Electron 的 dsh://open iframe 把窗口提到前台。
      function jumpToSession(sid) {
        try {
          if (sid) {
            var ws = lookupService('uiWorkspace');
            if (ws && typeof ws.openSession === 'function') ws.openSession(sid);
          }
        } catch (e) {}
        try { root.focus(); } catch (e) {}
        try {
          var ua = (root.navigator && root.navigator.userAgent) || '';
          if (/electron/i.test(ua) && typeof document !== 'undefined' && document.body) {
            var frame = document.createElement('iframe');
            frame.style.display = 'none';
            frame.src = 'dsh://open';
            document.body.appendChild(frame);
            setTimeout(function () { try { frame.remove(); } catch (e) {} }, 1000);
          }
        } catch (e) {}
      }
      // m04774① / m05207：应用内浮层卡片 —— 现在是「唯一」的弹窗。
      // 用户实测「人在别的会话界面 / 系统通知没授权」时只有提示声、看不到任何弹窗，
      // 根因是 new Notification 被 Notification.permission 门槛挡住；浮层直接挂在
      // document.body 上，只要 DSH 窗口还在（哪怕停在别的会话界面）就一定可见，
      // 完全不依赖系统通知权限。m05207 又反馈「浮层 + OS 横幅两张卡太复杂」，
      // 于是去掉 OS 横幅，每次提醒只留这一张浮层 + 提示音。点击跳到对应会话，
      // 8 秒自动关闭。
      function showInAppToast(title, body, isDone, sid) {
        try {
          if (typeof document === 'undefined' || !document.body) return null;
          var el = document.createElement('div');
          el.className = 'dsh-pws-inapp-toast';
          // 原生 title 属性：卡片有 maxWidth 会截断，悬停可看完整标题；
          // data-sid 标明这条卡片属于哪个会话，便于定位/自动化，也是冒烟里
          // 旧「通知对象」断言读取 tag 的来源。
          el.title = title;
          // 兼容旧「通知对象」的行为断言：把正文与会话 tag 也挂在唯一浮层上，
          // 让冒烟里对具体内容 / 点击跳转 / 关闭的校验继续适用于这张卡。
          el.opts = { body: body || '', tag: 'dsh-plugin-wechat-session:' + (sid || '') };
          if (el.setAttribute) el.setAttribute('role', 'status');
          if (el.setAttribute) el.setAttribute('data-sid', sid || '');
          var st = el.style || {};
          st.position = 'fixed';
          st.right = '16px';
          st.bottom = '16px';
          st.zIndex = '2147483647';
          st.maxWidth = '360px';
          st.boxSizing = 'border-box';
          st.padding = '12px 14px';
          st.borderRadius = '10px';
          st.background = isDone ? 'rgba(31,111,235,0.96)' : 'rgba(138,75,0,0.96)';
          st.color = '#fff';
          st.fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';
          st.fontSize = '13px';
          st.lineHeight = '1.5';
          st.boxShadow = '0 8px 28px rgba(0,0,0,0.35)';
          st.cursor = 'pointer';
          st.wordBreak = 'break-word';
          var head = document.createElement('div');
          head.textContent = title;
          head.style.fontWeight = '600';
          head.style.marginBottom = body ? '4px' : '6px';
          el.appendChild(head);
          if (body) {
            var para = document.createElement('div');
            para.textContent = body;
            para.style.opacity = '0.92';
            para.style.maxHeight = '96px';
            para.style.overflow = 'hidden';
            el.appendChild(para);
          }
          var hint = document.createElement('div');
          hint.textContent = t('notifyClickJump');
          hint.style.marginTop = '8px';
          hint.style.opacity = '0.7';
          hint.style.fontSize = '11px';
          el.appendChild(hint);
          // m05207：浮层本身作为「唯一的通知对象」放进 liveToasts。close()
          // 与旧 OS Notification 的 close() 行为对齐（置 closed 标记 + 从队列
          // 移除），点击跳会话也复用同一入口；历史行为断言得以继续适用。
          el.closed = false;
          el.close = function () {
            try { el.remove(); } catch (e) {}
            el.closed = true;
            var i = liveToasts.indexOf(el);
            if (i >= 0) liveToasts.splice(i, 1);
          };
          el.onclick = function () { el.close(); jumpToSession(sid); };
          document.body.appendChild(el);
          liveToasts.push(el);
          // 裸 setTimeout 在沙箱里进 miscTimeouts，8 秒后自动关闭。
          setTimeout(function () { try { el.close(); } catch (e) {} }, 8000);
          noteLog('log', '【应用内浮层】' + title + (body ? '：' + body : ''));
          return el;
        } catch (e) {
          noteLog('error', '应用内浮层异常：' + (e && e.message ? e.message : String(e)));
          return null;
        }
      }
      // m05207：用户决定「只留一个弹窗」。每次提醒只挂一张应用内浮层卡片
      // （右下角、不依赖系统通知权限、点一下跳到对应会话），不再同时弹 OS
      // 系统通知横幅——之前「浮层 + 横幅」两张卡重复打扰。提示音仍保留。
      // 第 4 参 sid 作为「点击要跳过去的会话 id」。
      function toast(title, body, isDone, sid) {
        // 每次提醒前再确认一次权限并重试音频解锁（m03179 的音频治本保留：
        // 后台页会把 AudioContext 挂起，playCue 内每次重试 unlockAudio）。
        ensurePermission();
        // 唯一的弹窗：应用内浮层，与系统通知权限无关，人在别的会话界面也看得到。
        showInAppToast(title, body, isDone, sid);
        // 提示音始终尝试；浮层弹出与否都不影响它响。
        playCue(isDone);
      }
      function withdrawToasts() {
        for (var i = 0; i < liveToasts.length; i++) {
          try { liveToasts[i].close(); } catch (e) {}
        }
        liveToasts.length = 0;
      }

      // ────────────── 超时批次（会话级，v1.3.0；m03992 双超时） ──────────────
      // 单批：提醒并入同一批；每条记住它属于哪个会话、何时到期（deadline）。
      // m03992：需选择 / 确认类用 attentionTimeoutSec（默认 60），任务跑完类用
      // timeoutSec（30）；批次计时器按「所有条目里最早的 deadline」重排，到期
      // 那批才发微信，未到期的条目留在批次里等下一次计时。
      // 「已响应」= 切到那条会话去看 / 把那条待办处理掉（用户决策）。
      var batch = null; // { timer, firesAt, items: [{..., deadline}] }

      function cancelBatch() {
        if (!batch) return;
        if (batch.timer) { try { root.clearTimeout(batch.timer); } catch (e) {} }
        batch = null;
      }

      // 让计时器对准「当前批次里最早的那个 deadline」。条目增减后调用即可，
      // 目标没变时不会重复注册计时器（避免冒烟里 batchTimeouts 数量漂移）。
      // firstDelay：新建批次时由 noteAlert 传入的精确秒数（30 / 60 * 1000），
      // 保证延迟是整数、可被精确断言；重排（已有计时器）才按剩余时间重算。
      function scheduleBatchTimer(firstDelay) {
        if (!batch || !batch.items.length) return;
        var target = Infinity;
        for (var i = 0; i < batch.items.length; i++) {
          if (batch.items[i].deadline < target) target = batch.items[i].deadline;
        }
        if (batch.timer && batch.firesAt === target) return;
        var hadTimer = !!batch.timer;
        if (hadTimer) { try { root.clearTimeout(batch.timer); } catch (e) {} }
        batch.firesAt = target;
        var delay = (!hadTimer && typeof firstDelay === 'number')
          ? firstDelay
          : Math.max(0, target - Date.now());
        batch.timer = root.setTimeout(fireBatchTimeout, delay);
      }

      function sendWechat(note) {
        var cfg = readConfig();
        if (!cfg.enabled || !cfg.wechatEnabled) return Promise.resolve({ ok: false, skipped: true });
        // 留空的两个 ID 交给 Host half：它会回退到 cordis.patch.yml 的服务端兜底值；
        // 若两边都没配，Host 返回 400 missing-target（只记一条 warn，不影响桌面提醒）。
        var body = JSON.stringify({
          title: note.title,
          desp: note.desp,
          botId: cfg.botId || '',
          targetId: cfg.targetId || '',
        });
        return fetch('/__dsh-plugin-wechat-session/wechat', {
          method: 'POST',
          mode: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: body,
        })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          // Host half 会把 dsh-im 的英文报错翻成中文 message；设置页优先显示它。
          .then(function (j) { return { ok: !!j.ok, detail: j, message: j.message || '' }; })
          .catch(function (e) { return { ok: false, error: String(e && e.message || e), message: String(e && e.message || e) }; });
      }

      // m04774②：微信内容改成「干净整洁、清晰易懂」的极简超时提醒。
      //   旧版把问题原文、编号选项、回复格式、dsh-im 绑定长文全拼成文字墙，
      //   用户实测看得很乱；而且本插件发的微信结构上收不到回复，在那条下回
      //   「1」只会落到 dsh-im 机器人聊天会话（不会回填）。
      //   现在：一行标题 + 每条会话一行（会话名 + 事件 / 已完成时间）+ 一句
      //   「别在这条下回复」。真回填由 dsh-im 原生同步提问完成，配置指引只放在
      //   设置页（wechatSyncGuide），不再塞进每条微信里。
      function summarize(items) {
        var attention = [];
        var done = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === 'done') done.push(items[i]); else attention.push(items[i]);
        }
        var cfg = readConfig();
        var title = attention.length ? t('wechatTitle') : t('wechatDoneTitle');
        var parts = [];
        if (attention.length) {
          parts.push(t('wechatAttentionHead', { n: cfg.attentionTimeoutSec }));
          for (var a = 0; a < attention.length; a++) {
            var it = attention[a];
            var event = (it.kind === 'question') ? t('kindQuestion') : t('kindApproval');
            parts.push(t('wechatSession', {
              name: it.sessionName || sessionLabel(it.sid), event: event,
            }));
          }
          parts.push('');
          parts.push(t('wechatAttentionFoot'));
        }
        if (done.length) {
          if (attention.length) parts.push('');
          parts.push(t('wechatDoneHead'));
          for (var k = 0; k < done.length; k++) {
            parts.push(t('wechatDoneLine', {
              name: done[k].sessionName || sessionLabel(done[k].sid),
              time: new Date(done[k].at).toLocaleTimeString('zh-CN'),
            }));
          }
        }
        parts.push('');
        parts.push(t('wechatFooterNew'));
        return { title: title, desp: parts.join('\n') };
      }

      // 当前 uiSession 快照，用来判断某条待办有没有被处理掉。
      function statusSnapshot() {
        try {
          var found = interactionStore(lookupService('uiSession'));
          if (found && typeof found.store.getSnapshot === 'function') return found.store.getSnapshot();
        } catch (e) {}
        return null;
      }

      // 这条批次项是否已经被用户「知道了」：
      //   · 切到那条会话去看（它变成当前会话）——两类通用；
      //   · 需要选择 / 确认：待办消失（pendingInteraction 没了）= 已处理；
      //   · 任务跑完：没有「处理掉」这个动作，只靠切过去看，避免把
      //     running→false / completionUnread 的自然变化误判成「已查看」。
      function itemResponded(it, cur, snap) {
        // 「切到那条会话去看」= 提醒发出之后当前会话变了，而且正好切到它。
        // 必须用 curAt（提醒发出时的当前会话）做基准：若提醒本来就是为当前
        // 会话弹的（窗口在后台时连当前会话也提醒），「仍是当前会话」不算查看，
        // 否则那类提醒会在入批的同一帧被立刻回收掉。
        if (it.sid && cur && it.sid === cur && cur !== it.curAt) return true;
        if (it.kind !== 'done' && snap && typeof snap.get === 'function' && it.sid) {
          var v = snap.get(it.sid);
          if (!v) return true;              // 会话从快照消失
          return !v.pendingInteraction;     // 待办被点掉了
        }
        return false;
      }

      // 会话切换 / 状态变化时，把已响应的条目从批次里拿掉；全响应就整批取消。
      // fromReturn=true 表示窗口刚从后台回到前台：此时若某条提醒本来就是为
      // 「当前这条会话」弹的（后台时会出现），人回来了就当已经看到。
      // 多会话前台场景里提醒是给别的会话的（it.curAt !== it.sid），不受影响。
      function reapBatch(fromReturn) {
        if (!batch) return;
        var cur = currentSessionId();
        var snap = statusSnapshot();
        var kept = [];
        for (var i = 0; i < batch.items.length; i++) {
          var it = batch.items[i];
          var cameBackToOwn = fromReturn && it.curAt && it.curAt === it.sid;
          if (!cameBackToOwn && !itemResponded(it, cur, snap)) kept.push(it);
        }
        batch.items = kept;
        if (!batch.items.length) { cancelBatch(); withdrawToasts(); }
        else scheduleBatchTimer();   // 删掉最早那条后，重新对准剩下里最早的 deadline
      }

      function fireBatchTimeout() {
        var b = batch;
        batch = null;
        if (!b || !b.items.length) return;
        // m03992：两类超时不同，计时器对准的是「最早那条 deadline」，到点时
        // 只发已经到期的条目；还没到期的（比如 60 秒的待拍板 vs 30 秒的完成）
        // 装回新批次，重排计时器继续等，不被这一批一起提前发掉。
        // 计时器本来就是对准 b.firesAt（这批里最早的 deadline）注册的；真实运行时
        // Date.now() 到点会 >= firesAt。取两者较大值，既保证「按时触发」时能立刻
        // 判定到期项，也能在计时器被延迟触发、多个 deadline 都已过时一次发完。
        var now = Math.max(Date.now(), (b && b.firesAt) || 0);
        var due = [];
        var remaining = [];
        for (var i = 0; i < b.items.length; i++) {
          if (b.items[i].deadline <= now) due.push(b.items[i]);
          else remaining.push(b.items[i]);
        }
        // 超时点按最新状态再筛一次：只发仍未响应的条目，避免「切过去又切回来」
        // 或「刚点掉待办」却还是发了微信。前台也照发（用户决策②）。
        var cur = currentSessionId();
        var snap = statusSnapshot();
        var pendingItems = [];
        for (var j = 0; j < due.length; j++) {
          if (!itemResponded(due[j], cur, snap)) pendingItems.push(due[j]);
        }
        if (pendingItems.length) {
          sendWechat(summarize(pendingItems)).then(function (res) {
            if (!res.ok && !res.skipped) {
              try { (root.console || console).warn('[dsh-plugin-wechat-session] 微信补发失败', res.detail || res.error); } catch (e) {}
            }
          });
        }
        if (remaining.length) {
          batch = { timer: null, firesAt: null, items: remaining };
          scheduleBatchTimer();
        }
      }

      // 从 pendingInteraction（0.1.2+ 的 PendingApproval / PendingQuestion 或扁平
      // payload）里抽出「具体内容」当通知正文，最长 160 字。照抄 dsh-notify-me
      // lib/client.js:2847-2885：兼容扁平字段、toolName+reason、questions[0].question。
      // 抽不到时返回 ''，由 noteAlert 回退成一句中文说明。
      function textFromPayload(payload) {
        if (!payload || typeof payload !== 'object') return '';
        function clip(s) {
          var str = String(s).replace(/\s+/g, ' ').trim();
          return str.length > 160 ? str.slice(0, 160) + '…' : str;
        }
        var keys = ['text', 'question', 'prompt', 'title', 'summary', 'description',
                    'message', 'operation', 'toolName', 'reason', 'name', 'tool'];
        for (var i = 0; i < keys.length; i++) {
          var v = payload[keys[i]];
          if (typeof v === 'string' && v.trim()) {
            var s = clip(v);
            if (keys[i] === 'toolName' && typeof payload.reason === 'string' && payload.reason.trim()) {
              return s + ' · ' + clip(payload.reason);
            }
            return s;
          }
          if (v && typeof v === 'object' && typeof v.text === 'string' && v.text.trim()) {
            return clip(v.text);
          }
        }
        var qs = payload.questions;
        if (Object.prototype.toString.call(qs) === '[object Array]' && qs[0]) {
          var q = qs[0];
          var qk = ['question', 'title', 'text', 'detail'];
          for (var j = 0; j < qk.length; j++) {
            if (typeof q[qk[j]] === 'string' && q[qk[j]].trim()) return clip(q[qk[j]]);
          }
        }
        return '';
      }

      // 统一的短文本裁剪（微信清单用；与 textFromPayload 内部的 clip 同语义）。
      function clipText(s, max) {
        var str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        return str.length > max ? str.slice(0, max) + '…' : str;
      }

      // m03992：从真实的 PendingQuestion / PendingApproval（或扁平 payload）里
      // 抽出结构化的「问题原文 + 编号选项」信息，存进批次条目，供微信清单使用。
      // 对象形态（dsh-user-questions/src/types.ts、dsh-client-ui-approval）：
      //   questions: [{ id, question, header?, detail?, options?: [{label, description?}],
      //                 multiSelect?, intent?: {kind, approve?, reject?} }]
      //   PendingApproval: { kind:'approval', toolName, reason?, displayReason? }
      // 抽不到任何可用信息时返回 null，summarize 会回退成 label。
      function describeInteraction(payload) {
        if (!payload || typeof payload !== 'object') return null;
        var detail = {
          question: '', options: [], multiSelect: false, toolName: '', reason: '',
          isApproval: false, approve: '', reject: '',
        };
        try {
          detail.toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
          detail.reason = typeof payload.reason === 'string' ? payload.reason
            : (typeof payload.displayReason === 'string' ? payload.displayReason : '');
          var qs = payload.questions;
          var isArr = Object.prototype.toString.call(qs) === '[object Array]';
          var first = isArr && qs[0] && typeof qs[0] === 'object' ? qs[0] : null;
          if (first) {
            var qk = ['question', 'text', 'title', 'detail'];
            for (var i = 0; i < qk.length; i++) {
              if (typeof first[qk[i]] === 'string' && first[qk[i]].trim()) {
                detail.question = clipText(first[qk[i]], 240); break;
              }
            }
            if (typeof first.header === 'string' && first.header.trim()) {
              detail.question = '[' + clipText(first.header, 40) + '] ' + detail.question;
            }
            var opts = first.options;
            if (Object.prototype.toString.call(opts) === '[object Array]') {
              for (var j = 0; j < opts.length && detail.options.length < 12; j++) {
                var o = opts[j];
                if (typeof o === 'string' && o.trim()) {
                  detail.options.push({ label: clipText(o, 80), description: '' });
                } else if (o && typeof o === 'object' &&
                           typeof o.label === 'string' && o.label.trim()) {
                  detail.options.push({
                    label: clipText(o.label, 80),
                    description: typeof o.description === 'string' ? clipText(o.description, 120) : '',
                  });
                }
              }
            }
            detail.multiSelect = !!first.multiSelect;
          }
          if (!detail.question) {
            var fk = ['question', 'text', 'prompt', 'title', 'summary', 'description',
                      'message', 'name', 'tool'];
            for (var k = 0; k < fk.length; k++) {
              if (typeof payload[fk[k]] === 'string' && payload[fk[k]].trim()) {
                detail.question = clipText(payload[fk[k]], 240); break;
              }
            }
          }
          // 审批 / 计划评审意图：优先用 intent 自带的 approve/reject 措辞，
          // 与 dsh-im 的「批准/拒绝/同意/不同意/yes/no」回填协议对齐。
          var intent = first && first.intent ? first.intent : payload.intent;
          var kind = intent && typeof intent === 'object' ? intent.kind : payload.kind;
          detail.isApproval = (kind === 'approval' || kind === 'plan-review');
          if (intent && typeof intent === 'object') {
            if (typeof intent.approve === 'string') detail.approve = clipText(intent.approve, 40);
            if (typeof intent.reject === 'string') detail.reject = clipText(intent.reject, 40);
          }
        } catch (e) {}
        if (!detail.question && !detail.options.length && !detail.toolName && !detail.isApproval) return null;
        return detail;
      }

      function noteAlert(kind, label, sid, key, payload) {
        var cfg = readConfig();
        if (!cfg.enabled) return;
        // 后台委托 / 子代理会话一律静默：Mnemon「自进化」落盘任务、被
        // modsearch 调用的后台子代理等会创建这类会话，宿主会话列表本就不显示
        // 它们。放在所有提醒（弹窗 + 提示音 + 30 秒批次→微信）的唯一入口最
        // 前面，四类判据一次覆盖三类通道，不改 shouldAlert / batch / sendWechat。
        if (isIgnoredSession(sid)) return;
        // v1.3.0：会话级判据。当前正看着的那条保持安静；其他会话（哪怕窗口
        // 就在前台）照常提醒。窗口整个在后台时所有会话都算没在看，全部提醒。
        if (!shouldAlert(sid)) return;

        var isDone = kind === 'done';
        // v1.5.0：三类都弹一张「带具体内容」的系统通知，格式对齐 dsh-pet 的卡片：
        //   标题 = 「会话名 · 事件标签」（正在申请权限 / 模型在等你回答 / 对话完成）；
        //   正文 = 从 pendingInteraction 抽出来的具体问题 / 工具名+原因，
        //          抽不到时回退成一句带事件类型的中文说明（不再是空洞卡片）。
        //   点击跳转由 toast 第 4 参 sid 保证；提示音由 toast 内部统一播放。
        var eventLabel = isDone ? t('notifyDoneLabel')
          : (kind === 'approval' || kind === 'plan-review' ? t('notifyApproval') : t('notifyQuestion'));
        var body = textFromPayload(payload)
          || (eventLabel + '：' + t('notifyBodyFallback',
               { n: isDone ? cfg.timeoutSec : cfg.attentionTimeoutSec }));
        toast(sessionLabel(sid) + ' · ' + eventLabel, body, isDone, sid);

        if (!batch) batch = { timer: null, firesAt: null, items: [] };
        // m03992：每条自带 deadline。需选择 / 确认类用 attentionTimeoutSec（默认
        // 60），任务跑完类沿用 timeoutSec（30）。批次计时器对准最早那条 deadline，
        // 到期只发到期的，未到期的留在批次里继续等。
        var waitSec = isDone ? cfg.timeoutSec : cfg.attentionTimeoutSec;
        var deadline = Date.now() + waitSec * 1000;
        // 同一会话同一事件只进批次一次（running 边沿 + completionUnread 上升沿
        // 共用 doneAt 去抖，这里的 dedupe 再兜一层）。
        var dedupe = (key || kind) + ':' + (sid || 'global');
        var exists = false;
        for (var i = 0; i < batch.items.length; i++) {
          if (batch.items[i].dedupe === dedupe) { exists = true; break; }
        }
        if (!exists) batch.items.push({
          kind: kind, label: label, sid: sid, dedupe: dedupe, at: Date.now(),
          deadline: deadline,
          curAt: currentSessionId(), // 提醒发出时正看着哪条（用于判定「后来切过去」）
          // m03992：微信清单要用的结构化信息——会话名 + 问题原文 / 编号选项。
          sessionName: sessionLabel(sid),
          detail: isDone ? null : describeInteraction(payload),
        });
        // 同一批最多合并 20 条，避免长时间没处理时无限增长
        if (batch.items.length > 20) batch.items.splice(0, batch.items.length - 20);
        scheduleBatchTimer(waitSec * 1000);
      }

      // 窗口从后台回来 / 页面变可见：只做一次会话级回收，不再无条件取消整批
      // （人在窗口前时这些事件本来就不触发，新规则下也不算「已响应」）。
      // fromReturn=true 让「提醒本来就是给当前会话弹的」那类条目算已看到。
      function onReturn() { reapBatch(true); }

      // ───────────────────────── uiSession 订阅 ─────────────────────────
      var rootCtx = null;
      var uiStore = null;
      var uiSub = null;
      var uiSource = null;
      var uiBaseline = Object.create(null);   // sid -> { key, running }
      var doneBaseline = Object.create(null); // sid -> 已报过的 completionUnread
      var doneAt = Object.create(null);       // sid -> 上次 done 提醒时间（去抖，避免同一帧双触发）

      function lookupService(name) {
        var svc = null;
        try { if (rootCtx && typeof rootCtx.get === 'function') svc = rootCtx.get(name) || null; } catch (e) { svc = null; }
        if (svc) return svc;
        try { if (rootCtx && rootCtx.reflect && typeof rootCtx.reflect.get === 'function') svc = rootCtx.reflect.get(name) || null; } catch (e) { svc = null; }
        if (svc) return svc;
        try { if (rootCtx && name in rootCtx) svc = rootCtx[name] || null; } catch (e) { svc = null; }
        return svc;
      }
      function isStore(s) {
        return !!s && typeof s.getSnapshot === 'function' && typeof s.subscribe === 'function';
      }
      function interactionStore(svc) {
        if (svc && isStore(svc.sessionStatus)) return { store: svc.sessionStatus, source: 'sessionStatus' };
        if (svc && isStore(svc.pendingInteractions)) return { store: svc.pendingInteractions, source: 'pendingInteractions' };
        return null;
      }
      function pendingOf(value, source) {
        if (!value) return null;
        if (source === 'sessionStatus') return value.pendingInteraction || null;
        return value;
      }
      function labelOf(kind) {
        if (kind === 'approval' || kind === 'plan-review') return t('kindApproval');
        if (kind === 'question') return t('kindQuestion');
        return t('kindDone');
      }

      function detachUiSession() {
        if (uiSub) { try { uiSub(); } catch (e) {} uiSub = null; }
        uiStore = null;
        uiSource = null;
        uiBaseline = Object.create(null);
        doneBaseline = Object.create(null);
        doneAt = Object.create(null);
      }

      // seedOnly=true：只把当前快照写进基线，绝不触发提醒。用于订阅建立时的首次
      // 求值——插件加载那一刻已经挂着的待办 / 已完成状态属于「陈旧状态」，不该补发。
      function evalUiStatus(seedOnly) {
        var found = interactionStore(lookupService('uiSession'));
        if (!found || typeof found.store.getSnapshot !== 'function') return;
        var snap = found.store.getSnapshot();
        if (!snap || typeof snap.forEach !== 'function') return;
        var seen = Object.create(null);
        var now = Date.now();

        snap.forEach(function (value, sid) {
          if (!value) return;
          seen[sid] = true;
          var it = pendingOf(value, found.source);
          var key = it ? (it.key || (it.kind + ':' + sid)) : null;
          var prev = uiBaseline[sid] || null;
          var running = found.source === 'sessionStatus' ? !!value.running : false;

          // ① ② 需要确认权限 / 需要手动选择：pendingInteraction 新出现
          if (it && !seedOnly && (!prev || prev.key !== key)) {
            // v1.5.0：把 pendingInteraction 本身当 payload 传进去，让通知正文能显示
            // 具体问题文本 / 工具名+原因（对齐 dsh-pet 的带内容卡片）。
            noteAlert(it.kind === 'approval' || it.kind === 'plan-review' ? 'approval' : 'question',
                      labelOf(it.kind) + '·' + sessionLabel(sid), sid, key, it);
          }

          // ③ 任务跑完：running 由 true 变 false 且当前没有待处理交互
          //    与 completionUnread 上升沿共用一条 1 秒去抖，避免同一帧双触发。
          //    seed 阶段只写基线，不报 done。
          var reportDoneEdge = false;
          if (found.source === 'sessionStatus' && prev && prev.running && !running && !it) {
            reportDoneEdge = true;
          }
          // completionUnread 上升沿（覆盖页面重挂 / 合并快照漏掉 running 边沿的情况）
          var unread = !!value.completionUnread;
          if (unread && !it && !doneBaseline[sid]) {
            doneBaseline[sid] = true;
            reportDoneEdge = true;
          } else if (!unread) {
            delete doneBaseline[sid];
          }
          if (reportDoneEdge && !seedOnly) {
            var last = doneAt[sid] || 0;
            if (now - last > 1000) {
              doneAt[sid] = now;
              noteAlert('done', t('kindDone') + '·' + sessionLabel(sid), sid, 'done');
            }
          }

          uiBaseline[sid] = { key: key, running: running };
        });
        for (var old in uiBaseline) {
          if (!seen[old]) { delete uiBaseline[old]; delete doneBaseline[old]; delete doneAt[old]; }
        }
        // 快照变了：可能用户刚点掉某条待办，回收批次里已响应的条目。
        if (!seedOnly) reapBatch();
      }

      function bindUiSession() {
        var svc = lookupService('uiSession');
        var found = interactionStore(svc);
        if (!found) return;                       // 启动竞态：稍后重试
        if (uiSub && uiStore === found.store) return; // 已绑定
        if (uiSub) detachUiSession();
        uiStore = found.store;
        uiSource = found.source;
        uiSub = found.store.subscribe(function () { try { evalUiStatus(); } catch (e) {} });
        // 首次求值只建基线：插件加载时已经挂着的待办 / 已完成状态不补发提醒。
        evalUiStatus(true);
      }

      // sessions.list 的订阅：当前会话一切换，就回收批次里「切过去看了」的条目。
      // 与 uiSession 一样用 1500ms 重试消除启动竞态。
      function bindSessionsList() {
        try {
          var svc = lookupService('sessions');
          var list = svc && svc.list;
          if (!list || typeof list.subscribe !== 'function' || typeof list.getSnapshot !== 'function') return;
          if (listSub && listStore === list) return;
          if (listSub) { try { listSub(); } catch (e) {} }
          listStore = list;
          listSub = list.subscribe(function () { try { reapBatch(); } catch (e) {} });
        } catch (e) {}
      }
      function detachSessionsList() {
        if (listSub) { try { listSub(); } catch (e) {} listSub = null; }
        listStore = null;
      }

      // ───────────────────────── 设置页（settings.section） ─────────────────────────
      // m05207：改版为「卡片式分组」。原来是一整段说明文字 + 一串平铺黑白输入框，
      // 用户反馈太丑。现在：简短副标题 + 可展开的完整说明 + 按主题分组的圆角卡片，
      // 统一配色 / 间距 / 输入框样式 / 主次按钮，配置项分组一目了然。
      function makeSettingsView(ctx) {
        var h = React.createElement;
        // 组件身份必须稳定：每次渲染都返回新函数会让 React 反复卸载重挂。
        return function SettingsView() {
          var counter = React.useState(0);
          var rerender = function () { counter[1](function (n) { return n + 1; }); };
          var statusState = React.useState('');
          var setStatus = statusState[1];
          var status = statusState[0];
          var detailState = React.useState(false);          // 完整说明是否展开
          var detailOpen = detailState[0];
          var setDetailOpen = detailState[1];
          var cfg = readConfig();

          // 统一设计令牌（内联样式，避免依赖宿主 CSS 变量）。
          var S = {
            page: { padding: '20px', maxWidth: '620px', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', fontSize: '13px', lineHeight: '1.6' },
            h2: { margin: '0 0 4px', fontSize: '19px', fontWeight: 700 },
            sub: { margin: '0 0 4px', fontSize: '12px', opacity: 0.7 },
            link: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '12px', opacity: 0.75, textDecoration: 'underline' },
            full: { margin: '8px 0 0', padding: '10px 12px', borderRadius: '10px', background: 'rgba(127,127,127,0.07)', fontSize: '12px', opacity: 0.85, lineHeight: '1.7' },
            card: { background: 'rgba(127,127,127,0.06)', border: '1px solid rgba(127,127,127,0.18)', borderRadius: '12px', padding: '14px 16px', marginBottom: '12px' },
            cardTitle: { fontSize: '12px', fontWeight: 700, letterSpacing: '0.4px', opacity: 0.6, marginBottom: '12px' },
            field: { marginBottom: '12px' },
            label: { fontWeight: 600, marginBottom: '6px' },
            hint: { opacity: 0.6, fontSize: '11.5px', marginTop: '5px', lineHeight: '1.5' },
            input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: '1px solid rgba(127,127,127,0.3)', background: 'rgba(127,127,127,0.08)', color: 'inherit', fontSize: '13px' },
            row: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
            range: { width: '100%', margin: '2px 0' },
            guide: { fontSize: '12px', lineHeight: '1.7', whiteSpace: 'pre-wrap' },
            btnRow: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
            btn: { type: 'button', style: { borderRadius: '8px', padding: '8px 14px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', border: '1px solid transparent' } },
            statusBox: { marginTop: '10px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(127,127,127,0.08)', fontSize: '12px' },
            foot: { opacity: 0.5, fontSize: '11px', marginTop: '6px' },
          };
          function card(title) {
            var kids = Array.prototype.slice.call(arguments, 1);
            return h.apply(null, ['section', { style: S.card }, h('div', { style: S.cardTitle }, title)].concat(kids));
          }
          function field(label, hint, control) {
            return h('div', { style: S.field },
              h('div', { style: S.label }, label),
              control,
              hint ? h('div', { style: S.hint }, hint) : null);
          }
          function checkbox(key, label) {
            return h('label', { style: S.row },
              h('input', {
                type: 'checkbox', checked: !!cfg[key], style: { accentColor: '#2f6feb' },
                onChange: function (e) { writeConfig({ [key]: !!e.target.checked }); rerender(); },
              }), label);
          }
          function input(key, type, extra) {
            return h('input', Object.assign({
              type: type,
              value: cfg[key],
              style: S.input,
              onChange: function (e) {
                var val = type === 'number' ? Number(e.target.value) : e.target.value;
                writeConfig({ [key]: val });
                rerender();
              },
            }, extra || {}));
          }
          function button(primary, label, onClick) {
            var st = Object.assign({}, S.btn.style, primary
              ? { background: '#2f6feb', color: '#fff' }
              : { background: 'rgba(127,127,127,0.12)', color: 'inherit', border: '1px solid rgba(127,127,127,0.28)' });
            return h('button', { type: 'button', style: st, onClick: onClick }, label);
          }

          function testDesktop() {
            // 测试弹一张「任务跑完 / 对话完成」带会话名 + 点击跳会话的浮层卡。
            var sid = currentSessionId();
            toast((sessionLabel(sid) || t('currentSession')) + ' · ' + t('notifyDoneLabel'),
                  t('notifyBodyFallback', { n: cfg.timeoutSec }), true, sid);
            setStatus(t('testDesktopOk'));
          }
          function testWechat() {
            if (!cfg.botId || !cfg.targetId) { setStatus(t('noKey')); return; }
            setStatus(t('testWechatSending'));
            sendWechat({ title: t('wechatTitle'), desp: '测试：' + t('sectionHintShort') }).then(function (res) {
              if (res.ok) { setStatus(t('testWechatOk')); return; }
              // 优先显示 Host 翻好的中文原因；没有再退回原始错误，避免再糊一坨 JSON。
              var reason = res.message || (res.detail && res.detail.message) || res.error
                || (res.detail && (res.detail.error || JSON.stringify(res.detail))) || '未知错误';
              setStatus(t('testWechatFail') + String(reason));
            });
          }

          return h('div', { style: S.page },
            h('h2', { style: S.h2 }, t('title')),
            h('p', { style: S.sub }, t('sectionHintShort')),
            h('button', { type: 'button', style: S.link,
              onClick: function () { setDetailOpen(!detailOpen); } },
              (detailOpen ? '▾ ' : '▸ ') + t('detailsLabel')),
            detailOpen ? h('p', { style: S.full }, t('sectionHint')) : null,
            // 基础
            card(t('groupBasic'),
              field(t('masterSwitch'), t('masterHint'), checkbox('enabled', t('masterSwitch')))),
            // 微信机器人 / 目标
            card(t('groupBot'),
              field(t('botId'), t('botIdHint'), input('botId', 'text', { placeholder: 'wx_xxxxxxxx 或整段「复制调用参数」' })),
              h('div', { style: { marginTop: '4px' } },
                field(t('targetId'), t('targetIdHint'), input('targetId', 'text', { placeholder: 'tgt_xxxxxxxx 或整段「复制调用参数」' })))),
            // 超时
            card(t('groupTimeout'),
              field(t('timeout'), t('timeoutHint'), input('timeoutSec', 'number', { min: 5, max: 3600, step: 1 })),
              field(t('attentionTimeout'), t('attentionTimeoutHint'), input('attentionTimeoutSec', 'number', { min: 5, max: 3600, step: 1 }))),
            // 提醒方式
            card(t('groupAlert'),
              field(t('sound'), t('soundHint'), checkbox('sound', t('sound'))),
              field(t('volume'), '', h('input', {
                type: 'range', min: 0, max: 1, step: 0.05, value: cfg.volume, style: S.range,
                onChange: function (e) { writeConfig({ volume: Number(e.target.value) }); rerender(); },
              })),
              field(t('wechat'), t('wechatHint'), checkbox('wechatEnabled', t('wechat')))),
            // 在微信里直接选择（配置指引，只放设置页）
            card(t('groupWechat'),
              h('div', { style: S.guide }, t('wechatSyncGuide'))),
            // 测试
            card(t('groupTest'),
              h('div', { style: S.btnRow },
                button(true, t('testDesktop'), testDesktop),
                button(false, t('testWechat'), testWechat)),
              status ? h('div', { style: S.statusBox }, status) : null),
            h('p', { style: S.foot }, t('saved') + ' · dsh-plugin-wechat-session v1.7.0'));
        };
      }

      // ───────────────────────── 插件主体 ─────────────────────────
      // 硬服务：sessions / locale / slots。uiSession 一律懒查（直接读 ctx.uiSession
      // 会抛 "cannot get property uiSession without inject"）。
      var inject = ['sessions', 'locale', 'slots'];

      function apply(ctx) {
        rootCtx = ctx;
        // 设置页（仅在完整 web profile：react + slots + locale 都在时）
        try {
          if (React && React.createElement && ctx.slots && ctx.locale &&
              typeof ctx.locale.register === 'function' && typeof ctx.slots.inject === 'function') {
            ctx.effect(function () {
              return ctx.locale.register(NS, { zh: UI_zh, en: UI_en });
            }, 'dsh-plugin-wechat-session: settings dictionaries');
            var tr = ctx.locale.bind(NS);
            // 组件只创建一次：槽的 render 工厂若每次返回新组件类型，React 会
            // 反复卸载重挂，输入焦点和内部 state 都会丢。
            var SettingsView = makeSettingsView(ctx);
            ctx.slots.inject('settings.section', function () {
              return ctx.slots.register({
                name: 'settings.section',
                id: 'dsh-plugin-wechat-session',
                order: 48,
                label: function () { return tr('nav'); },
                locale: NS,
                inject: function () { return { t: tr }; },
              }, function () {
                return React.createElement(SettingsView, null);
              });
            });
          }
        } catch (e) {
          try { (root.console || console).error('[dsh-plugin-wechat-session] 设置页不可用', e); } catch (e2) {}
        }

        // 所有 watcher 放进单个 effect，禁用 / HMR 时统一撤销。
        ctx.effect(function () {
          var disposed = false;
          var unsubs = [];
          var retryTimer = null;
          try {
            // 窗口可见 / 拿回焦点：只做一次会话级回收，不再无条件取消整批。
            var onVisibility = function () {
              try {
                if (typeof document !== 'undefined' && !document.hidden && document.visibilityState !== 'hidden') onReturn();
              } catch (e) {}
            };
            var onFocus = function () { onReturn(); };
            try { document.addEventListener('visibilitychange', onVisibility); } catch (e) {}
            try { root.addEventListener('focus', onFocus); } catch (e) {}
            unsubs.push(function () {
              try { document.removeEventListener('visibilitychange', onVisibility); } catch (e) {}
              try { root.removeEventListener('focus', onFocus); } catch (e) {}
            });

            // 首次用户手势仍解锁 WebAudio / 补一次权限申请（Electron 里
            // requestPermission 在手势里成功率最高），但不再「只此一次」：
            // 启动即申请 + 每次提醒前 ensurePermission() 都会重试。
            var onFirstGesture = function () {
              unlockAudio();
              ensurePermission();
              try { root.removeEventListener('pointerdown', onFirstGesture, true); } catch (e) {}
              try { root.removeEventListener('keydown', onFirstGesture, true); } catch (e) {}
            };
            try { root.addEventListener('pointerdown', onFirstGesture, true); } catch (e) {}
            try { root.addEventListener('keydown', onFirstGesture, true); } catch (e) {}
            unsubs.push(function () {
              try { root.removeEventListener('pointerdown', onFirstGesture, true); } catch (e) {}
              try { root.removeEventListener('keydown', onFirstGesture, true); } catch (e) {}
            });

            // 激活即主动申请通知权限（对齐 dsh-pet initNotify:3525），不依赖
            // 用户先点一下窗口。这是 m03179 的关键修复：窗口在后台、用户还没
            // 交互过时，旧版永远不申请权限、桌面弹窗永久弹不出来。
            ensurePermission();
            unlockAudio();

            bindSessionsList();
            bindUiSession();
            // 启动竞态：uiSession / sessions.list 可能晚一拍才激活，定期重试绑定。
            retryTimer = root.setInterval(function () {
              if (disposed) return;
              try { bindSessionsList(); bindUiSession(); } catch (e) {}
            }, 1500);
            try { (root.console || console).log('[dsh-plugin-wechat-session] 已激活（enabled=' + config.enabled + ', timeout=' + config.timeoutSec + 's）'); } catch (e) {}
          } catch (e) {
            try { (root.console || console).error('[dsh-plugin-wechat-session] 初始化失败', e); } catch (e2) {}
          }
          return function () {
            disposed = true;
            if (retryTimer) { try { root.clearInterval(retryTimer); } catch (e) {} }
            for (var i = 0; i < unsubs.length; i++) { try { unsubs[i](); } catch (e) {} }
            detachSessionsList();
            detachUiSession();
            cancelBatch();
            withdrawToasts();
          };
        }, 'dsh-plugin-wechat-session: watchers');

        // 全局调试 / 控制 API
        try {
          var api = root.__dshPluginWechatSession || {};
          Object.defineProperty(api, 'config', { get: function () { return readConfig(); }, configurable: true });
          api.testDesktop = function () {
            var sid = currentSessionId();
            var cfg = readConfig();
            toast((sessionLabel(sid) || t('currentSession')) + ' · ' + t('notifyDoneLabel'),
                  t('notifyBodyFallback', { n: cfg.timeoutSec }), true, sid);
          };
          api.testWechat = function () { return sendWechat({ title: t('wechatTitle'), desp: '测试' }); };
          api.debug = function () {
            // m03179：把两道硬门槛的运行时状态暴露出来，便于实测「为什么没弹/没响」。
            return {
              bound: !!uiSub, source: uiSource, away: isAway(),
              currentSid: currentSessionId(), sessionsBound: !!listSub,
              batch: batch && batch.items.length,
              notifyPermission: (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'),
              notifySound: !!(config && config.sound),
              audioState: audioCtx ? audioCtx.state : 'none',
              permissionPending: permissionPending,
            };
          };
          root.__dshPluginWechatSession = api;
        } catch (e) {}
      }

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null);
