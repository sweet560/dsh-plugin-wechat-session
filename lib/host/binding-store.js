/**
 * dsh-plugin-wechat-session — 绑定状态持久化（零 npm 依赖）。
 *
 * 把「微信显式绑定的会话集合 + 最近活跃会话」写到磁盘，默认与 iLink token
 * state 同目录（~/.dsh-plugin-wechat-session/bindings.json）。这样 DSH 重启或
 * 插件实例重建（remove/install、HMR 重载）后，绑定不丢失，无需重新 /use。
 *
 * 只依赖 node:fs/os/path，与 transport 的 state 文件同风格（mode 0o600、坏文件
 * 静默降级为空）。不 import 任何 DSH 包。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BINDING_FILE = path.join(os.homedir(), '.dsh-plugin-wechat-session', 'bindings.json');

/**
 * @param {string} [file] 绑定状态文件路径；缺省用 DEFAULT_BINDING_FILE。
 * @returns {{file: string, load(): {sessions: string[], activeSession: string|null}, save(data): void}}
 */
export function createBindingStore(file) {
  const target = file || DEFAULT_BINDING_FILE;

  function load() {
    try {
      if (target && fs.existsSync(target)) {
        const data = JSON.parse(fs.readFileSync(target, 'utf8'));
        const sessions = Array.isArray(data.sessions)
          ? data.sessions.filter((s) => typeof s === 'string' && s)
          : [];
        const activeSession = typeof data.activeSession === 'string' ? data.activeSession : null;
        return { sessions, activeSession };
      }
    } catch { /* 坏文件/权限问题 → 静默降级为空绑定 */ }
    return { sessions: [], activeSession: null };
  }

  function save(data) {
    if (!target) return;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({
        sessions: Array.isArray(data?.sessions) ? data.sessions : [],
        activeSession: data?.activeSession || null,
      }, null, 2), { mode: 0o600 });
    } catch { /* 写盘失败不影响运行 */ }
  }

  return { file: target, load, save };
}

export { DEFAULT_BINDING_FILE };
