# Changelog

All notable changes to slack-bus. Dates are when the version landed on `main`.

## 0.6.3 — 2026-05-25 — Slack connectivity in bus_status

The daemon logged "Socket Mode connected" once at boot and then never
tracked the link again — there was no way to ask "is the bus's link to
Slack healthy right now?". ([DIG-219](https://linear.app/digital-pine/issue/DIG-219))

- **Socket Mode state tracking.** Listeners on Bolt's `SocketModeClient`
  (`connecting` / `authenticated` / `connected` / `reconnecting` /
  `disconnecting` / `disconnected`) mirror the live state into a small
  struct. Duck-typed on `receiver.client` so a Bolt internals change
  degrades gracefully instead of crashing the daemon.
- **`bus_status` now returns a `slack` block:** `connected`, `state`,
  `seconds_since_last_event`, `last_connected_seconds_ago`,
  `last_disconnected_seconds_ago`, `connect_count`, `disconnect_count`.
  A healthy link sits in `connected`; an outage shows as the state
  sticking off `connected` with a growing `seconds_since_last_event`.
- **Reconnects are logged at info level, never ERROR.** Socket Mode
  rotates the websocket routinely — a `disconnected`/`reconnecting` cycle
  is normal churn, so alarming on it would be noise. Reconnects log
  `Socket Mode reconnected (connect #N)`.
- **Scope:** this is the INBOUND leg (replies/reactions) only. Outbound
  posting (Web API) is independent and surfaces failures per-call via
  v0.6.2's classifier; the client→daemon MCP transport is a third,
  separate leg that fails client-side as an "unhealthy" server.

## 0.6.2 — 2026-05-25 — Actionable error states

When a tool failed, the consuming agent got a generic `Error: <message>`
with no way to tell a transient failure from a permanent one. An agent
driving a scheduled post would either give up on a blip or loop on a
broken token. ([DIG-218](https://linear.app/digital-pine/issue/DIG-218))

- **`classifyError()` buckets failures** into `unreachable`,
  `rate_limited`, `auth`, `api`, and `unknown`, each with an actionable,
  retry-aware message. Duck-typed on `@slack/web-api`'s `WebAPICallError`
  shape (`err.code` + `err.data.error`) so a web-api version bump can't
  silently break classification.
  - `unreachable` (network/DNS, HTTP 5xx) → "safe to retry shortly."
  - `rate_limited` → "retry after Ns" using Slack's `retryAfter`.
  - `auth` (invalid/revoked/expired token, missing scope) → "will NOT
    resolve on retry — do not loop."
  - `api` (channel_not_found, etc.) → surfaced cleanly; already actionable.
- **Error log lines now carry `category=`** for one-grep triage of
  what class of failure a session hit.
- **Scope note:** a dead MCP *transport* (Claude Code can't reach the
  daemon) surfaces client-side as an "unhealthy" server and never reaches
  this handler — this classifier covers only the daemon-to-Slack leg.

## 0.6.1 — 2026-05-22 — Operational polish

The first "prototype → daily tool" pass. Focus is making the daemon
debuggable when something breaks at 3am.

- **Startup banner.** Every boot logs a divider line followed by version,
  instance, port, PID, Bun version, and the configured reaper timers — so
  a glance at the log shows you which build is running and how it's
  configured without curl-probing the live process.
- **Process-level safety net.** `uncaughtException` and `unhandledRejection`
  now route into the daemon log via `logError(...)`. Previously these
  would die silently or scatter to stderr where nothing collected them.
- **Bolt error handler.** `slackApp.error(...)` logs any error that
  escapes an event handler. Bolt's own logger previously swallowed
  these.
- **Greppable error tagging.** All operator-visible errors now start with
  `ERROR ` — `grep ERROR /tmp/slack-bus-*.log` is the new triage move.
- **Richer tool error logs.** Tool failures now include the tool name,
  the calling session id (first 8 chars), and a truncated JSON dump of
  the arguments. You can finally tell *which channel* a
  `channel_not_found` was for without re-running.
- **Slack lookup error visibility.** `getChannelName` / `getUserName`
  fall through to the raw ID on error — that's unchanged — but now they
  log the failure when it's anything other than the boring
  `channel_not_found` / `user_not_found` cases.
- **Better idle-reap log.** `session reaped (idle 0.0h)` becomes
  `session reaped (idle 7s)` or `... (idle 26.3h)` depending on
  magnitude.
- **Single source of truth for version.** `VERSION` is a top-level
  constant; the server config and banner both read it.
- **CHANGELOG.md.** Added retroactively from `git log` (this file).

## 0.6.0 — 2026-05-22 — Subscription TTLs + idle session reaper

Closes the production session leak ([DIG-203](https://linear.app/digital-pine/issue/DIG-203))
and adds per-subscription TTLs ([DIG-211](https://linear.app/digital-pine/issue/DIG-211)).

- **Idle session reaper.** Sweep every 60s, drop sessions where
  `now - lastSeen > 24h`. Mitigates a real leak — Claude Code doesn't
  send MCP DELETE on exit, so `onsessionclosed` never fires and the
  session map grew unbounded (125 sessions / 0 closed events in the
  first week of production).
- **Per-sub TTL.** `subscribe_channel`, `subscribe_thread`, and
  `post_message` accept optional `ttl_seconds`. Omitted = session-lifetime
  (no breaking change). Implemented by migrating `Session.threads` /
  `Session.channels` from `Set<string>` to `Map<string, number | null>`.
- **Observability.** `bus_status` reports `idle_seconds` per session,
  `expires_in_seconds` per sub, and `idle_reap_seconds` at the daemon
  level.
- **Env config.** `SLACK_BUS_IDLE_REAP_SECONDS` and
  `SLACK_BUS_REAPER_INTERVAL_SECONDS` override the defaults — primarily
  for testability (set to 5s/1s in probes), but also operational
  flexibility.

## 0.5.0 — File family rename

Tool naming alignment that unlocks mp4 + arbitrary file types alongside
the existing image path.

- `upload_image` → `upload_file` (any file type)
- `upload_snippet` → `upload_text` (in-memory string upload)
- `get_image_from_slack` → `get_file_from_slack`

## 0.4.0 — Reaction routing + `bus_status`

- Reactions on subscribed messages / channels now route to the relevant
  sessions as `reaction` / `reaction_removed` notifications.
- `bus_status` introspection tool — daemon state, active sessions,
  subscriptions. The bedrock for the v0.6.x lifecycle work.

## 0.3.0 — Phase 2 tool parity with the retired slack-api-mcp

- Restored the streaming family (`start_stream` / `append_stream` /
  `stop_stream`), thread status (`set_thread_status`), channel
  management (`create_channel` / `join_channel` / `invite_users` /
  `pin_message`), file ops, and lookup formatters from the previous
  separate MCP.
- `get_channel_context` thread-mode behavior fixed (was returning the
  bare ts instead of the thread's replies).

## 0.1.0 → 0.2.0 — Merge of bus + shim + slack-api-mcp

Replaces the prior three-piece split (daemon + per-session stdio shim +
separate slack-api-mcp) with a single `bus-mcp.ts` artifact speaking
Streamable HTTP MCP on localhost. Surfaced as
[DIG-160](https://linear.app/digital-pine/issue/DIG-160).
