# dsh-plugin-wechat-session (WeChat Session Bridge · Umbrella Bundle)

A reminder plugin for the **DeepSeek Harness desktop app**. It watches all your running
sessions and links desktop alerts with a WeChat fallback.

> When a session **needs your manual choice**, **needs permission approval**, or **finishes its
> turn**, it raises a **desktop notification (system toast + alert sound)** with the real content,
> and you can **click the notification to jump to that session**. If you neither switch to that
> session nor clear its pending item within the timeout, it sends a reminder to one fixed WeChat
> chat through the **dsh-im WeChat bot (regular WeChat)**. Two event classes have separate,
> configurable timeouts: **"needs choice / approval" defaults to 60s**, **"task finished" defaults
> to 30s**; the former's WeChat message is a checklist with the **original question + numbered
> options** so you can reply with a number / "approve" directly in WeChat (see Chinese README §3.1).

Installing this one package brings both the WeChat Session Bridge plugin and `@xmanrui/dsh-im`
(the WeChat bot). See the Chinese [README.md](./README.md) for full documentation.

## Features

- Three triggers: permission approval / manual question / task finished (end of a model turn).
- Content-rich toasts: title `session name · event label`, body extracted from `pendingInteraction`
  (question text / tool name + reason), capped at 160 chars.
- Click any notification to jump to the corresponding session (`uiWorkspace.openSession(sid)`).
- Session-level supervision: when the window is in the foreground, only sessions you are NOT
  looking at raise alerts (the one on screen stays quiet); when the window is in the background,
  all sessions raise alerts.
- "Responded" = switching to that session or clearing its pending item — cancels WeChat fallback.
- WeChat fallback via dsh-im proactive delivery; no external webhook / Server 酱 / SendKey needed.
- Per-class timeouts (choice/approval 60s, task-finished 30s by default), each item carrying its
  own deadline; the overdue batch is sent as a checklist: a **[waiting on you]** section with the
  question text and numbered options (reply format included) and a **[finished]** section that
  spells out "session「X」finished".
- "Reply directly in WeChat" is powered by **dsh-im two-way sync** (interactive questions / remote
  approvals), not by this plugin parsing replies: bind that session to a WeChat private chat with
  two-way sync enabled and make sure the Bot ID / Target ID here point to the same chat. dsh-im
  pushes the answerable prompt immediately; this plugin's checklist is a timeout back-up. See
  Chinese README §3.1 for the full setup guide.
- Umbrella bundle: one `insert` mounts two loader rows; dsh-im keeps an upgradeable `^5.10.0`
  range and stays on the npm official source.

## Install

```bash
dsh plugin --profile desktop add dsh-plugin-wechat-session
# or from local source:
dsh plugin --profile desktop add "file:F:/.../dsh-plugin-wechat-session"
```

Restart the DSH desktop app afterwards, then open **Settings → 微信会话互通**, fill in the
Bot ID + Target ID (copy Bot ID from dsh-im IM bot settings, and the targetId from "copy call
params"; pasting the whole JSON into either field splits automatically), and use the two test
buttons to verify.

## Depends on two plugins

| Part | Source | Role |
| --- | --- | --- |
| WeChat Session Bridge (this package) | `lib/index.js` + `lib/client.js` | watches all sessions, desktop toasts + sound, per-class timeout batches (60s / 30s), checklist WeChat messages, settings page, click-to-jump |
| `@xmanrui/dsh-im` | npm official source, `^5.10.0` | regular WeChat bot that delivers the timeout checklist; its two-way sync can also post answerable prompts and write your reply back to DSH |

## Development

```bash
npm test          # offline smoke test (pure Node)
npm run pack      # npm pack --dry-run
```

CI: `.github/workflows/test.yml` runs the smoke test on push/PR (Node 24, actions @v7);
`.github/workflows/publish.yml` publishes to npm via **Trusted Publishing (OIDC provenance)** when
`package.json` version becomes a value not yet on the registry, guarded by an idempotency check —
no `NPM_TOKEN` needed. `.github/workflows/sync-gitee.yml` mirrors `main` and tags to Gitee on every
push (needs the repository secret `GITEE_SSH_PRIVATE_KEY`).

Current version: **1.6.0**.

> Unreleased local change (not part of the published 1.6.0): WeChat fallback now uses per-class
> timeouts (choice/approval 60s, task-finished 30s) and sends a checklist with question text and
> numbered options (see §3.1 of the Chinese README). It is applied locally only; a new version
> will be published once the behavior is confirmed.
