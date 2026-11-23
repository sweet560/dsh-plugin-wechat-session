/**
 * dsh-plugin-wechat-session — 设置项持久化（零 npm 依赖）。
 *
 * 把「/new 新建会话所用的工作目录」写到磁盘，默认与 iLink token / 绑定状态
 * 同目录（~/.dsh-plugin-wechat-session/settings.json）。这样 DSH 重启或插件
 * 实例重建（remove/install、HMR 重载）后，工作目录配置不丢失。
 *
 * 只依赖 node:fs/os/path，与 binding-store / transport 的 state 文件同风格
 * （mode 0o600、坏文件静默降级为空）。不 import 任何 DSH 包。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SETTINGS_FILE = path.join(os.homedir(), '.dsh-plugin-wechat-session', 'settings.json');

/**
 * @param {string} [file] 设置文件路径；缺省用 DEFAULT_SETTINGS_FILE。
 * @returns {{file: string, load(): {newSessionCwd: string}, save(data): void}}
 */
export function createSettingsStore(file) {
  const target = file || DEFAULT_SETTINGS_FILE;

  function load() {
    try {
      if (target && fs.existsSync(target)) {
        const data = JSON.parse(fs.readFileSync(target, 'utf8'));
        return { newSessionCwd: typeof data.newSessionCwd === 'string' ? data.newSessionCwd : '' };
      }
    } catch { /* 坏文件/权限问题 → 静默降级为空 */ }
    return { newSessionCwd: '' };
  }

  function save(data) {
    if (!target) return;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({
        newSessionCwd: String(data?.newSessionCwd || ''),
      }, null, 2), { mode: 0o600 });
    } catch { /* 写盘失败不影响运行 */ }
  }

  return { file: target, load, save };
}

export { DEFAULT_SETTINGS_FILE };
