# dsh-plugin-wechat-session (WeChat Channel Peripheral · v2.1.0)

A reminder + WeChat channel plugin for the **DeepSeek Harness desktop app**. **v2.0.0 is a breaking rewrite**: it drops the `@xmanrui/dsh-im` aggregate dependency, talks to WeChat independently over the official iLink protocol, and does not take over session lifecycle — it is purely a **channel adapter + session referrer**. Sessions you explicitly bind with `/use` are persisted (no re-binding after restart). **v2.1.0 adds `/new` thin session creation**: send `/new` in WeChat to create a session in a configured working-folder workspace and bind it immediately (title gets a "微信 · " prefix, defaulting to "微信 · Clawbot").

## Features

- **Desktop alerts**: one in-app floating card (click to jump to the session) + sound when a session needs a choice / approval / finishes a turn; with parallel sessions, only the ones you are NOT watching alert.
- **Timeout WeChat fallback**: after 60s (choice/approval) or 30s (task finished) without action, a richly formatted WeChat card with the short prefix and title is left as a record.
- **Bidirectional free-form chat**: after `/use` binding or `/new` creation, plain text sent in WeChat is prompted into that session and the agent's final reply is mirrored back (intermediate thinking is not relayed line-by-line). The reply mirror is headed by a readable `DeepSeek Harness · Session「title」` line instead of a cryptic short code.
- **Bidirectional parallel multi-session approval**: in WeChat, `/use <sessionId>` explicitly binds a session; approval cards carry a short prefix (e.g. `[3f2a]`), and replying `3f2a=1` approve / `=0` reject / `=c` cancel is delivered precisely to that session. Approvals across sessions are fully parallel — no more 1:1 serialization.
- **Delayed reminders**: periodic reminder cards while an approval waits; auto-fallback on timeout or after the reminder cap; optional periodic summary of pending requests.
- **No misdelivery / no false alerts for stale sessions**: once a bound session is archived or deleted, WeChat messages get a clear "archived or deleted — bind another with /use or create one with /new" reply instead of being silently queued; archived/deleted sessions no longer raise a false "conversation finished" toast or WeChat card.

Full rewrite notes: [v2.0.0 release notes](docs/RELEASE_NOTES_v2.0.0.md) and [CHANGELOG](CHANGELOG.md).

## 1. Install & login

1. Install this package the usual DSH way (**single plugin — the dsh-im aggregate is no longer needed**).
2. Open the plugin settings → "WeChat channel · QR login" → "QR login" → scan with WeChat.
3. Credentials are saved automatically and the receive loop starts. State lives at `~/.dsh-plugin-wechat-session/ilink-state.json` (mode 0o600); re-scan when the token goes stale (errcode=-14).
4. (Optional) In settings → "New session (WeChat /new)" set the working folder — auto-saved as you type; `/new` registers it as a workspace so sessions land in that workspace group (never "Ungrouped"), persisted at `~/.dsh-plugin-wechat-session/settings.json`.

> No Bot ID / Target ID needed. Official iLink supports direct chats only (no group chats); tokens have a limited lifetime (~24h in community tests) and require re-scanning.

## 2. Drive sessions from WeChat (explicit addressing)

Sessions are referenced explicitly: bind an existing one with `/use`, or create one with `/new` (auto-bound). Bindings are persisted (no re-binding after restart). Every action uses an explicit session reference; the short prefix is the 6 chars after the common `session-` head (e.g. `session-91b2175-…` → `91b217`), avoiding the all-collide-into-`sessio` problem.

| Command | Effect |
| --- | --- |
| `/new` or `/new <title>` | Thin-create a session in the workspace matching the configured folder and bind it immediately; title gets a "微信 · " prefix (e.g. `/new 甜屿林风` → "微信 · 甜屿林风", default "微信 · Clawbot"); ready for chat right away |
| `/use <sessionId>` or `/use <prefix>` | Bind an existing session (multiple allowed; approvals run in parallel); prefix like `91b217` |
| `bind <session title>` or `/use <title>` | Bind by short title (e.g. `bind WeChat · Title`); no need to remember the full ID. Unique match binds directly; multiple matches return a candidate list |
| `/list` | List bound sessions and prefixes |
| `/release` | Release all bindings |
| `/help` or `/?` | Show help |
| `3f2a=1` / `3f2a=0` / `3f2a=c` | Approve / reject / cancel that session's oldest pending request (aliases: `1/y/yes`, `0/n/no`, `c/cancel`) |
| `3f2a 1A 2B` | Answer that session's ask_user_question (multi-select like `3f2a 1AB`); maps question number + letter to option labels |

- WeChat has a single interactive card: the DSH bottom-right floating notice stays instant; only after it times out without action does WeChat receive one richly formatted card (task finished / choice needed / approval needed), and that card itself is fillable.
- The rich card includes `/use <prefix>` and `bind <session title>` (filled with the actual triggering session); either line binds that session.
- Choice card: per-question text + `A/B/C` options, footer spells the actual prefix reply code, e.g. `3f2a 1A 2B` (multi-select `3f2a 1AB`), filling in that session precisely.
- Approval / plan-review card: footer spells the actual prefix reply code, e.g. `3f2a=1 approve / 3f2a=0 reject / 3f2a=c cancel`.
- Fill-in window defaults to 5 minutes (`approvalTimeoutMs`), leaving ample time after the floating notice times out and the card reaches WeChat.
- A reply without a prefix, or with an unknown prefix, gets a prompt to specify it explicitly — never guessed as "the latest one", so no cross-talk.
- Reply mirrors are delivered only for explicitly bound sessions, headed by `DeepSeek Harness · Session「title」` (falls back to the short code if the title is unavailable); approval/choice cards still use `[prefix]` as the reply code. Unbound sessions receive no reply mirror or chat input, but their timeout rich cards can still be answered by the card prefix (racing the native DSH UI answerer, first answer wins), never misrouted to the current bound session.

## 3. Configuration

`cordis.patch.yml` (or the settings page):

| Key | Default | Meaning |
| --- | --- | --- |
| `prefixLength` | 6 | Short session prefix length |
| `approvalTimeoutMs` | 300000 | Fill-in hard timeout (ms, default 5 min, covers floating-notice timeout → rich card → reply) |
| `remindIntervalMs` | 60000 | Reminder card interval (ms) |
| `maxReminders` | 3 | Max reminder cards |
| `permissionPreset` | `ask` | Timeout fallback: `ask` / `allow-once` / `reject` |
| `summaryIntervalMs` | 0 | Pending summary interval (0=off) |
| `questionTimeoutMs` | 0 | Choice fill-in timeout (0=use approvalTimeoutMs) |
| `newSessionTitle` | `微信 · Clawbot` | Fixed name when `/new` omits a title |

The working folder is not a patch key — set it in settings → "New session (WeChat /new)" (auto-saved as you type), persisted to `settings.json`; `/new` registers it as a workspace so the new session joins that group.

## 4. Structure

```
lib/
  channel/ilink.mjs     pure iLink protocol client (zero dependencies)
  channel/transport.js  iLink adapter (login/receive/typing/send), no DSH imports
  host/bridge.js         SessionEventBridge + ApprovalGate + command parsing
  host/binding-store.js  binding persistence (sessions + activeSession)
  host/settings-store.js /new working-folder persistence (newSessionCwd)
  index.js               host apply: 8 HTTP routes + ctx.on('session/event') / ctx.on('approval/request')
  client.js              QR-login + working-folder settings UI + in-app floating cards
```

Approval/question decision ownership stays on DSH's `approval/request` / `user-questions/request` waterfall: the plugin registers as an answerer, awaits the WeChat reply inside the callback, then returns the decision. The reply prefix is resolved not only against bound sessions but also against the **pending pool**, so rich cards from any session (including freshly `/new`-created, not-yet-`/use`-bound ones) can be answered by their own prefix without being misrouted to the current bound session. Bound sessions are answered exclusively by WeChat (no `next()`), matching "only one card on WeChat"; unbound sessions pass `next()` and race the native DSH UI answerer (`Promise.race`, first to settle wins, the loser is idempotently cancelled). In a race the winner decides and the other card may linger — an inherent limit of DSH's chain-veto waterfall.

## 5. Development

```bash
node --check lib/index.js lib/host/bridge.js lib/host/binding-store.js lib/host/settings-store.js lib/channel/transport.js lib/channel/ilink.mjs
node smoke/smoke-test.mjs   # 89 assertions: manifest + bridge unit + /new thin-create (workspaceId grouping + prefixed title) + settings-store + error localization + 8 routes/seams + QR login + parallel approval + any-session fill-in + body title line + archived/deleted-session guard + iLink e2e + client regressions
```

## 6. Trade-offs

- No auto create/follow of bindings: first bind explicitly with `/use` or create with `/new` (persisted afterwards, no re-binding after restart) — zero cross-talk and full decoupling.
- `/new` is "thin creation": one official DSH create (with workspaceId) + resume + rename call to get a sessionId and bind it immediately — no session pool, no auto cleanup, no mapping table; session lifecycle authority stays with DSH. `cwd` and `workspaceId` are mutually exclusive; passing only `cwd` lands "Ungrouped", so the folder is registered as a workspace first.
- The "微信 · " prefixed title may be overwritten by DSH's auto-title after the first prompt (rename has no pinned field); renaming afterwards is DSH's job.
- Direct chats only; token lifetime limited, re-scan when stale. The iLink protocol has no avatar interface; WeChat chat avatars are rendered by the client per account and cannot be controlled by this plugin.
- Historic v1.x (dsh-im aggregate) changes remain in [CHANGELOG](CHANGELOG.md).
