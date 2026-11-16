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
        // v1.8.0 选项1：全会话「实时分标签推送」。开启后，任意会话一出现
        // 需要选择 / 需要确认 / 任务跑完，就立刻（不等超时）把一条带会话标签
        // 与 /session <会话ID> 切换命令的极简微信推到同一个私聊。默认关闭，
        // 零副作用；真回填仍交 dsh-im 双向同步（deliverModelAnswers）。
        realtimePush: false,
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
        groupTest: '测试',
        // v1.8.0 选项1：全会话实时分标签推送 + /session 串行切换。
        groupRealtime: '多会话 · 实时推送（选项1）',
        realtimeSwitch: '全会话实时推送',
        realtimeSwitchHint: '开启后，任意会话一出现「需要选择 / 需要确认 / 任务跑完」，就立刻（不等超时）把一条带会话标签、会话 ID 和 /session 切换命令的极简微信发到同一个私聊。多个 DSH 会话共用这一个微信对话，靠 /session <会话ID> 串行切换后继续聊；回答全文由 dsh-im 双向同步回投。本插件发的微信收不到回复，切换命令请直接在微信里发。',
        testRealtime: '测试实时推送',
        // 实时推送微信正文（分标签）
        rtTitleQuestion: 'DSH · 会话等你处理',
        rtTitleDone: 'DSH · 会话已完成',
        rtHead: '【会话「{name}」· {event}】',
        rtSessionId: '会话 ID：{id}',
        rtSwitch: '在微信里发 /session {id} 即可切到该会话继续对话。',
        rtFoot: '（本条是实时状态提醒，勿在其下回复；回答全文与选项卡由 dsh-im 双向同步推送。）',
        // 用户定制「任务完成卡片」5 行模板（done 专用）：拼成整段作为 desp、
        // title 留空，避免 Host 在标题与正文之间多插一个空行。
        // {time}=完成时刻 HH:MM:SS；行尾空格与「【 已完成 】」内部空格逐字保留。
        rtDoneL1: 'DeepSeek Harness · 会话「{name}」【 已完成 】 {time}',
        rtDoneL2: '▸ 在微信里发送：',
        rtDoneL3: '/session {id} ',
        rtDoneL4: '即可切到该会话继续对话。 ',
        rtDoneL5: '—— 本条为实时状态提醒，勿在此回复 ——',
        // 用户定制「需要选择 / 授予权限」卡：与「任务完成」卡同款骨架，
        // 首行状态动态（【 需要选择 】/【 授予权限 】）+ 发出时刻；其余行共用 rtDoneL2~L5。
        rtPendingL1: 'DeepSeek Harness · 会话「{name}」【 {event} 】 {time}',
        rtEventQuestion: '需要选择',
        rtEventApproval: '授予权限',
        // 用户定制：选择 / 审批卡在切换指引后附「选择卡片的内容」，读真实选项。
        rtOptionsHead: '选择卡片的内容：',
        rtOptionLine: '选项{n}：{label}',
        // 正文段开头标记：让具体问题从指引/选项里跳出来，用户要求醒目标识「这是正文内容」。
        rtBodyMark: '📌 正文：',
        // 任务完成卡正文引导行：纯完成通知没有待选正文，用一句引导与另两张卡呼应。
        rtDoneBody: '📌 正文：任务已跑完，切过去查看回答全文',
        sectionHint: '多条会话并行时，只提醒你「没在看」的那些：正盯着的那条保持安静，其他会话需要确认、需要选择或任务跑完时，都弹一张带具体内容、点一下就能切到对应会话的应用内浮层卡片（右下角，不依赖系统通知权限，在别的会话界面也看得到）。「需选择 / 确认」与「任务跑完」各有独立超时（默认 60 / 30 秒，可在下面改），超时没切过去看 / 没把待办处理掉，就发一条极简微信提醒。若想直接在微信里回「1」选择并让任务继续，请按 dsh-im 文档把当前会话绑定到已开启双向同步的微信私聊，选项卡由 dsh-im 原生同步提问推送并回填。你离开窗口时所有会话都提醒。',
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
        // 回 1 选择并让任务继续」由 dsh-im 原生同步提问完成，详见 dsh-im 文档。
        wechatAttentionHead: '【等你处理】以下会话已等你 {n} 秒：',
        wechatDoneHead: '【已完成】以下会话这一轮已跑完：',
        wechatSession: '· 会话「{name}」· {event}',
        wechatDoneLine: '· 会话「{name}」已完成（{time}）',
        wechatAttentionFoot: '本条只是超时提醒，别在它下面回复；微信里直接选请用 dsh-im 推送的选项卡（绑定步骤见设置页）。',
        wechatFooterNew: '以上条目处理掉（回 DSH 点掉待办）后就不会再补发。',
        notifyApproval: '正在申请权限',
        notifyQuestion: '模型在等你回答',
        notifyDoneLabel: '对话完成',
        notifyBodyFallback: '点这条通知切到该会话查看具体内容；{n} 秒内没看会发微信。',
        notifyClickJump: '点击这条通知即可切到对应会话查看结果。',
        // 底部「关于本插件」信息卡（参考图2：DeepSeek 聊天设置页的关于卡）。
        aboutTitle: '关于本插件',
        aboutVersion: '插件版本号',
        aboutAuthor: '作者',
        aboutLicense: '开源许可证',
        aboutFeatures: '功能简介',
        aboutFeatureText: '多条会话并行时逐条监督超时，右下角应用内浮层卡片 + 提示音提醒，超时极简微信留底；可开启全会话实时分标签推送，在微信上用 /session 串行切换会话实时交互。',
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
        groupTest: 'Test',
        groupRealtime: 'Multi-session · realtime push (option 1)',
        realtimeSwitch: 'Realtime push for all sessions',
        realtimeSwitchHint: 'When on, any session that needs a choice / approval / finishes a task instantly (without waiting for the timeout) pushes a minimal WeChat message with the session tag, session ID and a /session switch command to the same private chat. Multiple DSH sessions share this one WeChat chat; use /session <sessionID> to switch serially and keep talking; full answers are relayed back by dsh-im two-way sync. Messages this plugin sends cannot receive replies, so send the switch command directly in WeChat.',
        testRealtime: 'Test realtime push',
        rtTitleQuestion: 'DSH · session needs you',
        rtTitleDone: 'DSH · session finished',
        rtHead: '[Session "{name}" · {event}]',
        rtSessionId: 'Session ID: {id}',
        rtSwitch: 'Send /session {id} in WeChat to switch to this session and keep talking.',
        rtFoot: '(This is a realtime status notice; do not reply under it. Full answers and option cards are pushed by dsh-im two-way sync.)',
        // 与 UI_zh 的 rtDoneL1-L5 成对（t() 一律走 UI_zh，这里仅为字典对称；微信卡恒中文）。
        rtDoneL1: 'DeepSeek Harness · session "{name}" [ FINISHED ] {time}',
        rtDoneL2: '▸ Send this in WeChat:',
        rtDoneL3: '/session {id} ',
        rtDoneL4: 'to switch to this session and keep talking. ',
        rtDoneL5: '—— This is a realtime status notice; do not reply here ——',
        rtPendingL1: 'DeepSeek Harness · session "{name}" [ {event} ] {time}',
        rtEventQuestion: 'choice needed',
        rtEventApproval: 'approval needed',
        rtOptionsHead: 'Choice card contents:',
        rtOptionLine: 'Option {n}: {label}',
        rtBodyMark: '📌 Body:',
        rtDoneBody: '📌 Body: task finished; switch over to read the full answer',
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

      // 低层：真正发出去的那一次 fetch。v1.8.0 把「超时补发」与「实时推送」
      // 共用同一条 Host /wechat 路由、同一份 body 契约（同一 URL / 同一 body，
      // 冒烟里 fetchCalls 计数与 v1.7.0 完全一致）。门禁一律放在调用方。
      function postWechat(note) {
        var cfg = readConfig();
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

      // v1.7.0 的超时补发入口：保留 enabled + wechatEnabled 两道门禁。
      function sendWechat(note) {
        var cfg = readConfig();
        if (!cfg.enabled || !cfg.wechatEnabled) return Promise.resolve({ ok: false, skipped: true });
        return postWechat(note);
      }

      // m04774②：微信内容改成「干净整洁、清晰易懂」的极简超时提醒。
      //   旧版把问题原文、编号选项、回复格式、dsh-im 绑定长文全拼成文字墙，
      //   用户实测看得很乱；而且本插件发的微信结构上收不到回复，在那条下回
      //   「1」只会落到 dsh-im 机器人聊天会话（不会回填）。
      //   现在：一行标题 + 每条会话一行（会话名 + 事件 / 已完成时间）+ 一句
      //   「别在这条下回复」。真回填由 dsh-im 原生同步提问完成，不再塞进每条微信里。
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

      // ──────────── v1.8.0 选项1：全会话实时分标签推送 ────────────
      // 目标：多个 DSH 会话 ↔ 单一微信私聊，直接在微信上实时交互。
      // 一个微信私聊在 dsh-im 里任一时刻只能绑 1 个 DSH 会话（1:1），所以
      // 「同时并行」做不到；本实现走「选项1」：
      //   · 下行（多→一）：uiSession.sessionStatus 是覆盖「全部会话」的现成
      //     数据源，任意会话一出现待选择/待确认/完成边沿，就立刻（不等超时）
      //     把一条「分标签」极简微信发到同一个私聊，带上会话 ID 与
      //     /session <会话ID> 切换命令。复用现成 postWechat，不重复造轮子。
      //   · 上行（一→多）：用户在同一私聊发 dsh-im 原生命令 /session <会话ID>
      //     即可把该私聊切到对应会话继续聊（workspace-command.mjs 的
      //     SESSION_BIND_COMMAND），旧会话保留、可再切回 = 串行切换。会话 ID
      //     直接取 uiSession 快照的 sid（即 sessionId，无空格，可直接作参数）。
      //   · 回答全文 / 选项卡：不自建（agent-3 结论：client 侧拿不到全会话
      //     正文），沿用 dsh-im 双向同步（deliverModelAnswers）回投当前绑定会话。
      // 本插件发的微信结构上收不到回复，故切换命令由用户在微信里直接发，
      // dsh-im 入站命令处理；这条实时消息只做「哪个会话、什么事件、怎么切」。
      function summarizeRealtime(kind, sid, payload) {
        var isDone = kind === 'done';
        // 用户定制「任务完成卡片」：done 走逐字 5 行模板，整段作 desp、title 留空。
        // 微信会把单个换行折叠成空格（5 行挤成一段），故行间用空行（'\n\n'）强制分段；
        // 完成时刻取「本条发出时刻」HH:MM:SS，格式沿用 summarize() 的 wechatDoneLine。
        if (isDone) {
          var clock = new Date(Date.now()).toLocaleTimeString('zh-CN');
          var doneDesp = [
            t('rtDoneL1', { name: sessionLabel(sid), time: clock }),
            t('rtDoneL2'),
            t('rtDoneL3', { id: sid }),
            t('rtDoneL4'),
            t('rtDoneBody'),
            t('rtDoneL5'),
          ].join('\n\n');
          return {
            title: '',
            desp: doneDesp,
            // 时间每秒都在变，绝不能进内容指纹，否则状态抖动跨过一秒就又发一张卡。
            // done 卡除时间外完全由 sid 决定，指纹只取 sid + kind，保持稳定。
            fingerprint: String(sid) + '\u0001' + String(kind),
          };
        }
        // 「需要选择 / 授予权限」卡：与「任务完成」卡同款骨架（首行状态 + 时间、
        // 行间空行分段、/session 切换、统一脚注），具体问题保留为独立一段。
        var event = (kind === 'approval' || kind === 'plan-review')
          ? t('rtEventApproval') : t('rtEventQuestion');
        var parts = [];
        parts.push(t('rtPendingL1', {
          name: sessionLabel(sid), event: event,
          time: new Date(Date.now()).toLocaleTimeString('zh-CN'),
        }));
        // 与「任务完成」卡共用第 2~4 行（发送指引），保证三类卡样式一致；
        // 用户要求把这段指引放在具体问题之前。
        parts.push(t('rtDoneL2'));
        parts.push(t('rtDoneL3', { id: sid }));
        parts.push(t('rtDoneL4'));
        // 「需要选择 / 授予权限」附一句具体问题，帮用户在微信里判断切不切过去。
        var one = textFromPayload(payload);
        if (one) parts.push(t('rtBodyMark') + one);
        // 用户定制：读真实待办里的编号选项，紧跟问题正文，每项独立成段；
        // 没有任何选项时整块不显示；按用户要求去掉「选择卡片的内容」表头。
        var optionFingerprint = '';
        var detail = describeInteraction(payload);
        if (detail && detail.options && detail.options.length) {
          for (var oi = 0; oi < detail.options.length; oi++) {
            var label = detail.options[oi].label || ('选项' + (oi + 1));
            parts.push(t('rtOptionLine', { n: oi + 1, label: label }));
            optionFingerprint += '\u0001' + String(oi + 1) + ':' + label;
          }
        }
        parts.push(t('rtDoneL5'));
        var desp = parts.join('\n\n');
        return {
          title: '',
          desp: desp,
          // 首行含每秒变化的 HH:MM:SS，绝不能进指纹（否则跨秒抖动又发一张）。
          // 指纹取「会话 + 事件 + 会话名 + 具体问题 + 编号选项」：不同问题 /
          // 选项 / 会话 / 事件天然是不同键，同一待办 60s 内重复边沿被吞掉，零误伤。
          fingerprint: String(sid) + '\u0001' + String(kind) + '\u0001'
            + String(sessionLabel(sid)) + '\u0001' + String(one) + optionFingerprint,
        };
      }

      // ──────────── v1.8.0 实时推送「短时间去重」 ────────────
      // 根因：uiSession.sessionStatus 是宿主 store 的快照，任务收尾时宿主会在
      // 很短时间里多次通知（running 抖动、completionUnread 反复置位、页面重挂
      // 重放）。evalUiStatus() 的 done 判定只有 doneAt 的 1000ms 去抖，question
      // 判定靠 pendingInteraction.key 判等；两次边沿只要间隔跨过 1 秒、或 key
      // 变一下，就会再次调用 pushRealtime()。而 pushRealtime 原本「无记忆」直发，
      // summarizeRealtime() 对 done 完全不含动态内容（payload=null）、对 question
      // 只取问题原文，两次拼出的 title/desp 一字不差 → 微信里出现两条一模一样
      // 的「DSH·会话已完成」。postWechat() 自身没有重试，重复不是它造成的；两处
      // 边沿也分属互斥分支，不会同帧各发一条。所以修复点就放在这个「唯一入口」。
      //
      // 策略：内存 Map 去重，键 = 会话 ID + 事件类型 + 完整正文（内容指纹）。
      // 正文指纹直接用 summarizeRealtime 的 title+desp：它已包含会话名、事件
      // 标签、具体问题原文、会话 ID 与 /session 命令，因此「不同会话 / 不同
      // 事件 / 不同问题」天然是不同键，不会被误抑制；只有「同一会话同一事件
      // 且正文完全相同」才会命中。
      var REALTIME_DEDUPE_WINDOW_MS = 60 * 1000;
      // 取 60 秒的理由：与「需选择 / 确认」类默认超时 attentionTimeoutSec(60s)
      // 同量级，覆盖用户说的「短时间内没操作就一直重复发」的典型抖动间隔；
      // 又不长到把「一分钟后状态确实又变了一次」的正常再推吞掉。窗口过期即
      // 允许再发并更新时间戳。
      var REALTIME_DEDUPE_MAX_KEYS = 256;
      // 长会话里会话 / 问题不断产生新键，封顶后整体清空（等价于重新开始一个
      // 窗口），配合每次发送前的过期项清理，避免 Map 无限增长造成内存泄漏。
      var realtimeDedupe = new Map();   // 去重键 -> 上次真正发出 postWechat 的时间戳(ms)

      // 实时推送唯一入口：默认关（realtimePush:false），开启后才发。
      // 与 noteAlert 对齐：子代理会话静默；但「不看 shouldAlert」——
      // 选项1 要的是「全会话」实时感知，连正盯着的那条状态变化也推，
      // 这样微信里能持续看到每条会话的进度（用 /session 切过去继续聊）。
      function pushRealtime(kind, sid, payload) {
        var cfg = readConfig();
        if (!cfg.enabled || !cfg.realtimePush) return;
        if (isIgnoredSession(sid)) return;
        // 先拼正文，再取「稳定内容指纹」做去重键。done 卡正文含每秒变化的
        // HH:MM:SS，不能直接用 title+desp 当指纹（否则跨秒的状态抖动会再发一张）。
        // fingerprint 由 summarizeRealtime 给出：done 只取 sid+kind；question/approval
        // 仍含事件类型 + 具体问题原文，保证「不同会话 / 不同事件 / 不同问题」零误伤。
        var note = summarizeRealtime(kind, sid, payload);
        var dedupeKey = note.fingerprint;
        var now = Date.now();
        var last = realtimeDedupe.get(dedupeKey);
        // 窗口内且时钟没有回拨 → 直接吞掉，不调用 postWechat（重复的真凶）。
        // now < last 视为时钟回拨，不抑制，重新计时以免长期卡住不发。
        if (typeof last === 'number' && now >= last
            && now - last < REALTIME_DEDUPE_WINDOW_MS) return;
        // 顺带清理过期项：每次真正要发送时扫一遍，过期的键立刻删掉。
        realtimeDedupe.forEach(function (ts, key) {
          if (now - ts >= REALTIME_DEDUPE_WINDOW_MS) realtimeDedupe.delete(key);
        });
        if (realtimeDedupe.size >= REALTIME_DEDUPE_MAX_KEYS) realtimeDedupe.clear();
        realtimeDedupe.set(dedupeKey, now);
        try {
          postWechat(note).then(function (res) {
            if (!res.ok) {
              // 发送失败（Host 400 missing-target / 网络异常等）时撤销这次的键，
              // 让下一次状态边沿还能重试，不把「失败」误记成「已发过」。
              realtimeDedupe.delete(dedupeKey);
              try { (root.console || console).warn('[dsh-plugin-wechat-session] 实时推送失败', res.detail || res.error); } catch (e) {}
            }
          });
        } catch (e) {
          realtimeDedupe.delete(dedupeKey);
          try { (root.console || console).warn('[dsh-plugin-wechat-session] 实时推送异常', e); } catch (e2) {}
        }
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
            // v1.8.0 选项1：全会话实时分标签推送（默认关，见 pushRealtime）。
            pushRealtime(it.kind === 'approval' || it.kind === 'plan-review' ? 'approval' : 'question',
                         sid, it);
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
              // v1.8.0 选项1：全会话实时分标签推送（与 noteAlert 同一去抖）。
              pushRealtime('done', sid, null);
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

          // 统一设计令牌：参考「DeepSeek 聊天设置」页（图2），颜色全部取自 DSH
          // 主题别名令牌 var(--dsw-*)，明暗主题自动适配，不写死任何颜色。
          // 卡片用「细边框 + 圆角 + 浅一档底色」，卡内每行用细分隔线分开。
          var S = {
            page: { boxSizing: 'border-box', maxWidth: '620px', padding: '20px 24px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '1.6' },
            h2: { margin: '0 0 12px', fontSize: '16px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
            sub: { margin: '0 0 8px', fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-tertiary)' },
            link: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-link, var(--dsw-alias-label-primary))', textDecoration: 'underline' },
            full: { margin: '10px 0 0', padding: '10px 12px', borderRadius: 'var(--dsw-radius-sm)', border: '.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-1)', fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)' },
            card: { boxSizing: 'border-box', margin: '0 0 14px', padding: '12px 18px 14px', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-sm)', background: 'var(--dsw-alias-bg-layer-1)' },
            cardTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '4px' },
            field: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '14px 0', borderBottom: '.5px solid var(--dsw-alias-border-l3)' },
            label: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
            hint: { margin: 0, fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-tertiary)' },
            input: { boxSizing: 'border-box', width: '100%', marginTop: '2px', padding: '6px 10px', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-sm)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', font: 'var(--dsw-font-xxs-12)' },
            row: { display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontSize: '13px' },
            range: { width: '100%', margin: '2px 0', accentColor: 'var(--dsw-alias-label-link, var(--dsw-alias-label-primary))' },
            guide: { fontSize: '12px', lineHeight: '1.6', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-tertiary)' },
            btnRow: { display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '14px 0 0' },
            btn: { type: 'button', style: { borderRadius: 'var(--dsw-radius-sm)', padding: '6px 14px', cursor: 'pointer', fontSize: '12px', fontFamily: 'var(--dsw-font-xxs-12)' } },
            statusBox: { marginTop: '10px', padding: '10px 12px', borderRadius: 'var(--dsw-radius-sm)', border: '.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-base)', fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)' },
            foot: { marginTop: '12px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
            // 底部「关于本插件」卡：两栏网格，标签列固定宽、值列自适应。
            aboutSectionTitle: { margin: '18px 0 10px', fontSize: '13px', fontWeight: 600 },
            aboutRow: { display: 'grid', gridTemplateColumns: '88px minmax(0, 1fr)', columnGap: '10px', alignItems: 'baseline', padding: '5px 0', fontSize: '12px', lineHeight: '1.6' },
            aboutLabel: { whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-tertiary)' },
            aboutValue: { minWidth: '0', wordBreak: 'break-word', color: 'var(--dsw-alias-label-primary)' },
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
            return h('label', { style: S.label },
              h('input', {
                type: 'checkbox', checked: !!cfg[key],
                style: { width: '16px', height: '16px', margin: 0, cursor: 'pointer', accentColor: 'var(--dsw-alias-label-link, var(--dsw-alias-label-primary))' },
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
              ? { background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)', border: '.5px solid var(--dsw-alias-label-primary)' }
              : { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', border: '.5px solid var(--dsw-alias-border-l3)' });
            return h('button', { type: 'button', style: st, onClick: onClick }, label);
          }
          // 「关于本插件」卡的一行：固定宽标签 + 自适应值（引用 deepseek-chat 的 infoRow）。
          function aboutRow(label, value) {
            return h('div', { style: S.aboutRow },
              h('span', { style: S.aboutLabel }, label),
              h('span', { style: S.aboutValue }, value));
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
          function testRealtime() {
            if (!cfg.botId || !cfg.targetId) { setStatus(t('noKey')); return; }
            setStatus(t('testWechatSending'));
            // 发一条样例：带会话标签、会话 ID 与 /session 切换命令，便于在微信里核对格式。
            var demoSid = currentSessionId() || 'session-demo';
            postWechat(summarizeRealtime('question', demoSid,
              { question: '这是一条测试：多会话实时分标签推送' })).then(function (res) {
              if (res.ok) { setStatus(t('testWechatOk')); return; }
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
            // v1.8.0 选项1：多会话实时推送（默认关，开关 + 说明 + 测试按钮）
            card(t('groupRealtime'),
              field(t('realtimeSwitch'), t('realtimeSwitchHint'), checkbox('realtimePush', t('realtimeSwitch'))),
              h('div', { style: S.btnRow },
                button(false, t('testRealtime'), testRealtime))),
            // 测试
            card(t('groupTest'),
              h('div', { style: S.btnRow },
                button(true, t('testDesktop'), testDesktop),
                button(false, t('testWechat'), testWechat)),
              status ? h('div', { style: S.statusBox }, status) : null),
            // 底部「关于本插件」信息卡（参考图2）
            card(t('aboutTitle'),
              aboutRow(t('aboutVersion'), '1.8.0'),
              aboutRow(t('aboutAuthor'), 'sweet560'),
              aboutRow(t('aboutLicense'), 'MIT'),
              aboutRow(t('aboutFeatures'), t('aboutFeatureText'))),
            h('p', { style: S.foot }, t('saved')));
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
          api.testRealtime = function () {
            var demoSid = currentSessionId() || 'session-demo';
            return postWechat(summarizeRealtime('question', demoSid,
              { question: '这是一条测试：多会话实时分标签推送' }));
          };
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
              realtimePush: !!(config && config.realtimePush),
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
