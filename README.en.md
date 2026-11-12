# dsh-plugin-wechat-session (WeChat Session Bridge · Umbrella Bundle)

A reminder plugin for the **DeepSeek Harness desktop app**. It watches all your running
sessions and links desktop alerts with a WeChat fallback.

> When a session **needs your manual choice**, **needs permission approval**, or **finishes its
> turn**, it raises a **desktop alert**: exactly ONE **in-app floating card** (does NOT depend on OS
> notification permission — visible even when you are on another session, click to jump there) plus
> an alert sound. No OS banner is shown anymore, so there is only one popup. If you neither switch to that
> session nor clear its pending item within the timeout, it sends a **minimal** WeChat reminder
> (just "which session is waiting", no walls of text) through the **dsh-im WeChat bot (regular
> WeChat)**. Two event classes have separate, configurable timeouts: **"needs choice / approval"
> defaults to 60s**, **"task finished" defaults to 30s**.
>
> To answer "1 / choose 1" directly in WeChat and let the task continue: that is done by **dsh-im
> native synced questions** — bind the current session to a WeChat private chat with two-way sync
> enabled, and dsh-im pushes a numbered option card as soon as the question appears; replying with
> a number writes the answer back into DSH. **Replies to messages this plugin sends are NOT
> received** — do not reply under that reminder. Setup steps: Chinese README §3.1.

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
- One in-app floating card only (no OS banner): it needs no OS notification permission and shows
  on any session screen, fixing "only the sound plays, no popup" without a second duplicate popup.
- Per-class timeouts (choice/approval 60s, task-finished 30s by default), each item carrying its
  own deadline. The overdue WeChat message is **minimal**: a **[waiting on you]** section listing
  just the session name and event, and a **[finished]** section spelling out "session「X」finished".
  No question text / numbered options / long setup prose in the message any more.
- "Reply directly in WeChat" is powered by **dsh-im native synced questions / remote approvals**,
  NOT by this plugin parsing replies: dsh-im listens to `user-questions/request` / `approval/request`
  and pushes a numbered option card to a WeChat private chat as soon as the question appears.
  One-time setup: enable two-way sync in dsh-im (General → Delivery), then `/sessionlist` and
  `/session <id>` in the chat to bind it to the current session. That card arrives immediately,
  not after the 60s timeout; this plugin's timeout message is only a minimal fallback — **do not
  reply under it**. See Chinese README §3.1.
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
| WeChat Session Bridge (this package) | `lib/index.js` + `lib/client.js` | watches all sessions, one in-app floating card + sound (no OS toasts), per-class timeout batches (60s / 30s), minimal WeChat reminders, card-grouped settings page, click-to-jump |
| `@xmanrui/dsh-im` | npm official source, `^5.10.0` | regular WeChat bot that delivers the minimal timeout reminder; its native synced questions / remote approvals post answerable numbered option cards and write your reply back to DSH |

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

Current version: **1.7.0**.

**v1.7.0 highlights**: ① desktop alerts are now a **single bottom-right in-app floating card**
(no system notification permission needed, visible even from another session); the OS banner was
removed so there is only one popup on screen; ② the settings page was regrouped into cards with a
short expandable description; ③ WeChat fallback uses per-class timeouts (choice/approval 60s,
task-finished 30s), each batch fired at its own deadline; ④ the WeChat message was cut from a
question+options+setup wall of text down to a minimal reminder ([WAITING]/[FINISHED], session name
only); ⑤ "reply 1 in WeChat" is handled by **dsh-im native synced questions** (one-time
`/sessionlist` → `/session <id>` binding), and this plugin's timeout message explicitly says not to
reply under it. See `docs/RELEASE_NOTES_v1.7.0.md`.

**v1.6.0 highlights**: ignored Mnemon background delegated/subagent sessions; fixed the
background "no popup, no sound" case; switched CI to npm trusted publishing (OIDC / provenance) and
GitHub main → Gitee auto-sync; filled repository Topics and submitted the marketplace listing PR.
See `docs/RELEASE_NOTES_v1.6.0.md` and §9 of the Chinese README.
