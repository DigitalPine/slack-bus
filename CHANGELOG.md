# Changelog

All notable changes to slack-bus. Dates are when the version landed on `main`.

## 0.8.0 — 2026-07-30 — Entity resolution (agent-DX)

Slack delivers message text with machine-encoded entity tokens (`<@U0123>`,
`<#C0456>`, `<!here>`, `<https://x|label>`). Live probes against real channels
confirmed both user and channel mentions arrive **bare** in practice (no
inline `|name` fallback), forcing the agent to either guess identity inline or
issue a follow-up lookup — most of the time it just won't, and answers degrade
into "someone in some channel reacted to something."

- **New pure module `resolve-entities.ts`** — `extractEntityIds(text)` plus
  `applyEntityResolution(text, maps)` with unit-test coverage (25 cases) of
  every token shape: bare/fallback user, bare/fallback channel, `<!here>` /
  `<!channel>` / `<!everyone>`, `<!subteam^…>`, `<!date^…>`, labeled and bare
  URLs, mailto, unknown tokens, HTML-entity unescape. Lookup misses fall back
  to the bare id rendered as `@U0123` / `#C0456` — never throws.
- **Wired at three boundaries** in `bus-mcp.ts`:
  - `get_channel_context` — collects all referenced ids across the batch,
    resolves once through the existing user/channel caches, rewrites each
    message's `text` (preserving original on `text_raw` when changed).
  - Inbound `message` notification — `content` arrives resolved; `meta.text_raw`
    surfaces when a rewrite happened.
  - Inbound `reaction` / `reaction_removed` notification — the target
    message's author (`item_user`) is now resolved and named in the content
    string and as `meta.item_user_name`.
- **Reactor identity (#3 from the agent-DX audit)** — per-message reactions in
  `get_channel_context` now include `users: [...]` with resolved display names
  for each reactor. Agents can answer "who reacted with :tada:?" without a
  follow-up `users.info` call.
- `get_channel_context` tool description updated to advertise the new shape so
  the agent reads `text` as canonical and only reaches for `text_raw` when it
  needs the bracket-escaped form.

## 0.7.1 — 2026-06-05 — Channel re-adoption (DIG-279)

When the client's MCP push pipe (the GET SSE stream) is severed but the daemon
stays up — an idle-reaped-but-still-live session, a network blip, a graceful
stream close — the client reconnects ~1s later carrying its *old* `mcp-session-id`.
The SDK 404s that unknown sid, which the client treats as fatal: it abandons the
push stream while POST keeps working, so the session looks healthy but silently
renders nothing (the DIG-279 zombie).

- **Re-adoption.** The HTTP handler now forks on the unknown-sid GET event-stream
  reconnect and answers **200 + a fresh live stream coerced onto the same sid**
  (`buildSessionServer(adoptId)`: `sessionId` + `_initialized` coercion), instead
  of falling through to the 400 that strands the client. A priming-flush SSE
  comment is included as harmless insurance (not load-bearing on Bun.serve).
- **Subscription rehydration.** Because slack-bus routing is subscription-gated, a
  re-adopted session with empty subs would render a live pipe but route zero Slack
  events. Dropped sessions now retain their subscription set (`retainedSubs`, TTL-
  swept); re-adoption rehydrates it.
- **Validated** against a real `claude-code@2.1.165` receiver on an isolated rig:
  forget-but-stay-up → transparent recovery + render (n=2). **Measured limit:** a
  *true process restart* (kickstart) RSTs both pipes and the client **ends the
  session** rather than reconnecting — so re-adoption covers the stream-severed
  case, not restarts. Restart the daemon only when sessions can be relaunched.
- Test harness (gated, inert in prod): `SLACK_BUS_NO_SLACK` boots HTTP-only;
  `SLACK_BUS_DEBUG_LEVERS` enables `/debug/{sessions,forget,push}`.

## 0.7.0 — 2026-06-02 — Canvas tools

Slack canvases — rich Slack-native documents — are now first-class. Five tools
wrap the canvas API, with descriptions and error handling shaped around the
real edge cases (verified empirically against both a free and a paid workspace
before shipping, not guessed from docs).

- **`create_canvas`** — standalone canvas (paid only) or, with `channel_id`, a
  canvas attached as a channel tab (works on free). **`create_channel_canvas`**
  — the channel's own built-in canvas (`conversations.canvases.create`, works on
  free). **`edit_canvas`** — append / insert-near / replace / delete-section /
  rename. **`lookup_canvas_sections`** — fetch section ids for targeted edits.
  **`delete_canvas`**.
- **Content is Slack-flavored markdown** (NOT Block Kit, NOT mrkdwn): headings,
  **bold**/_italic_/~~strike~~, code, checkboxes (done → struck-through), quotes,
  dividers, links, tables (≤300 cells), and `![alt](url)` images that render
  inline **only if Slack can publicly fetch the URL** — otherwise upload_file and
  embed the permalink. Cover images are UI-only (no API).
- **Free-tier DX, surfaced not buried.** A standalone-canvas attempt on a free
  workspace returns `free_teams_cannot_create_non_tabbed_canvases`; classifyError
  now buckets this as a new **`plan`** category with an actionable message ("free
  tier — pass channel_id or use create_channel_canvas") so the calling agent
  understands it hit a plan ceiling, not a request bug. A broader paid-only error
  family is matched defensively.
- **Gotcha baked into the tool docs:** canvas section ids are *ephemeral* — they
  change after every edit. `lookup_canvas_sections` and `edit_canvas` both tell
  the agent to re-look-up immediately before each targeted edit, never reuse.
- Direct JSON API calls (not the form-encoding WebClient) so nested
  `document_content` / `changes` arrays match Slack's spec; failures are reshaped
  into `WebAPICallError`-like errors so the shared classifier still applies.
- Manifest adds `canvases:write` + `canvases:read`; the live DP app was
  reinstalled to grant them.

## 0.6.7 — 2026-06-01 — Inbound log breadcrumbs (SLACK_BUS_DEBUG)

Inbound delivery had no log trail: when an event matched no subscription the
handler returned silently, so "I'm not getting notifications" was undiagnosable
from the log — you couldn't tell *never-arrived* (Socket Mode / scope problem)
from *arrived-but-no-matching-sub* from *matched-but-client-push-stream-dead*
(the silent `dispatched OK` lie, [DIG-279](https://linear.app/digital-pine/issue/DIG-279)).
([DIG-280](https://linear.app/digital-pine/issue/DIG-280))

- **`SLACK_BUS_DEBUG` env flag** (default off) + a `debug()` logger (prefixed
  `DEBUG ` for one-grep include/exclude). Gated because `slackApp.message`
  fires for every message in every channel the bot is in — always-on tracing
  would flood the log on a busy workspace.
- **Every inbound drop now leaves a breadcrumb under DEBUG**: subtype drops
  (edits, `file_share`, `thread_broadcast`, bot messages), empty-text/blocks-only
  messages, bot self-events, reactions on non-message items, and — the key one —
  `→ 0 sessions (no matching sub)` for both messages and reactions. That line's
  presence proves Slack delivered the event, isolating the failure to a
  missing/expired sub rather than the inbound socket.
- **`coerceMeta` logs dropped keys** under DEBUG — a null/undefined meta value
  usually means an upstream `getUserName`/`getChannelName` lookup failed.
- **No behavior change with the flag off** — all new lines are debug-gated;
  the live path is byte-for-byte identical until you opt in.
- Diagnosis flow: flip `SLACK_BUS_DEBUG=1`, restart, reproduce, read the log.
  (A future always-on alternative: a recent-inbound ring buffer in `bus_status`,
  noted on DIG-280.)

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
