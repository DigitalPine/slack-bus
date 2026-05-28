# Changelog

All notable changes to slack-bus. Dates are when the version landed on `main`.

## 0.6.6 — 2026-05-28 — Rendered timestamps at every agent boundary

Agents were handed raw Unix epoch timestamps (`"ts": "1779897289.590119"`)
with no human rendering, forcing epoch→date conversion in-head — an error
vector that caused a real misread (a batch of prior-day messages read as
"today", nearly producing a duplicate standup). ([DIG-242](https://linear.app/digital-pine/issue/DIG-242))

- **`format-time.ts`** — pure, unit-tested `renderTimestamp(ts, timeZone?)`
  that renders a Slack epoch into an absolute, unambiguous string:
  `2026-05-27 08:54 PDT (Wed)` — date, 24h time, tz abbreviation, weekday.
  Daemon-local zone by default; unparseable input returns the raw string
  (never throws).
- **`when` added alongside (never replacing) the raw `ts`** at every
  boundary a timestamp crosses to the agent: `get_channel_context` message
  objects (compact + full), and the inbound `notifications/claude/channel`
  events (`thread_reply`, `channel_message`, `reaction`/`reaction_removed`,
  which also gains `item_when` for the reacted message). The raw `ts` stays
  authoritative for API calls (`thread_ts` etc.).
- **`get_channel_context` description** now tells the agent `when` is
  authoritative — read time from it, don't recompute from `ts`.
- **Deliberately absolute only — no "today/yesterday".** Relative-to-now is
  a function of the agent's own sense of the current date (a separate
  concern), not slack-bus's. The agent compares the absolute `when` against
  its own known current date.

## 0.6.5 — 2026-05-25 — Lifecycle logic extracted + unit-tested (no behavior change)

Hardening pass, no functional change. The v0.6.0 lifecycle logic (per-sub
TTL expiry + idle session reaping) was inline in the daemon and had zero
pure tests — only live integration tests that *silently pass when no bus is
running*, which is how a stale assertion went unnoticed for days.

- **`lifecycle.ts`** — extracted `ttlToExpiresAt`, `isExpired`,
  `hasActiveSub`, `pruneExpiredSubs`, `isIdleExpired`, `formatIdle`,
  `threadKey` as pure functions with injectable `now` for deterministic
  time. The idle reaper now routes through `pruneExpiredSubs` /
  `isIdleExpired` / `formatIdle` instead of inline loops (behavior
  identical, boundary semantics preserved: TTL expires at `exp <= now`,
  idle reaps at strict `now - lastSeen > window`).
- **`tests/lifecycle.test.ts`** — 20+ assertions covering TTL parsing,
  expiry boundaries, prune counts, idle thresholds, and idle formatting.
  Runs with no bus, so `bun test` now carries real always-on signal
  (suite went 13 → 29 passing).

## 0.6.4 — 2026-05-25 — open_slack tool

- **New tool `open_slack`** (23 tools total). Runs `open -a Slack` on the
  host Mac to launch or focus the Slack desktop app from a Claude session
  — a dogfooding convenience. macOS-only (clean error elsewhere); throws
  with an "is Slack installed?" hint on non-zero exit. The description
  makes explicit that this touches only the local desktop client and has
  no bearing on message delivery — a deliberate counter to the Monday
  incident's mental model, where quitting the desktop app was assumed to
  have broken the bus. ([DIG-220](https://linear.app/digital-pine/issue/DIG-220))

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
