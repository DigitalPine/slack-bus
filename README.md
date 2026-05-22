# slack-bus

**Be in Slack while you're in Claude.**

Your Claude session is the source — work-in-progress, thinking, the rich context Slack messages can't fit. slack-bus brings the conversation back: teammates reply in Slack, the reply lands in your session as a system reminder, your agent answers from the source. You stay in flow. You stop being the middleman between your work and your team.

Async standups. Ticket shaping. Drive-by team Q&A. Handled by your agent from inside the work — not by you context-switching between Slack and Claude all day.

https://github.com/user-attachments/assets/f8aad3a6-2e5b-4ede-8943-08bee0bd245b

> **Status:** experimental. Built over a weekend. Working well enough to dogfood, rough enough that you should expect bumps. Feedback welcome.

## How it works

```
┌─ Claude Code session ─┐                  ┌─ Slack ─┐
│                       │                  │         │
│  slack-bus (MCP)      │── HTTPS ─────────│ Web API │  (post, react, look up...)
│   over HTTP           │── WebSocket ─────│ Socket  │  (inbound events)
└──────────┬────────────┘                  └─────────┘
           │ HTTP/SSE on localhost
           ▼
  ┌─ slack-bus daemon ─┐
  │ Single process     │
  │ Per Slack org      │
  │ Launchd-managed    │
  └────────────────────┘
```

One daemon, one Slack app, multiple Claude sessions can connect concurrently. Each session gets a unique `mcp-session-id` (assigned by MCP's HTTP transport) and its own subscription list — when you post a message, that session is auto-subscribed to replies in the resulting thread.

## The load-bearing experimental dependency

This depends on Claude Code's `--dangerously-load-development-channels server:<name>` flag, which surfaces `notifications/claude/channel` MCP notifications as system-reminder turns. The flag is undocumented and experimental. Anthropic may ship official "channels" support later — when they do, this code path may change.

While the flag exists: this is what it unlocks.

## Quick start

You'll need:

- macOS (the launchd plist is macOS-only; the daemon itself works anywhere Bun runs)
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Claude Code](https://claude.ai/code)
- A Slack workspace where you can install a custom app

### 1. Create the Slack app

Go to https://api.slack.com/apps → **Create New App** → **From a manifest**. Paste `slack-app-manifest.yml` from this repo. Replace the `YOUR_NAME` placeholders (most people use their first name — the convention is "<Your Name> (Claude)" so it's clear the bot is you, with Claude driving).

You need **two tokens** (not the Client Secret — see below):

- **`SLACK_APP_TOKEN`** (`xapp-...`) — for Socket Mode (inbound events).
  Under **Basic Information** → scroll to **App-Level Tokens** → **Generate Token and Scopes** → name it `slack-bus` → add the `connections:write` scope → **Generate** → copy.
- **`SLACK_BOT_TOKEN`** (`xoxb-...`) — for Web API calls (posting, lookups).
  Under **Install App** → **Install to Workspace** → authorize → copy the **Bot User OAuth Token** from the top of the page.
- Under **Socket Mode** (left sidebar) → confirm it's enabled.

> **Heads-up on the Client Secret.** "Basic Information" → **App Credentials** prominently shows a **Client ID**, **Client Secret**, **Signing Secret**, and **Verification Token**. You don't need any of those for slack-bus — they're for distributed apps doing OAuth install flows on arbitrary workspaces. slack-bus is a single-workspace bot you install yourself. The only two values that matter are the `xapp-` and `xoxb-` tokens above.

### 2. Install + configure tokens

```bash
git clone https://github.com/DigitalPine/slack-bus.git ~/Code/slack-bus
cd ~/Code/slack-bus
bun install
cp .env.example .env
```

Open `.env` and paste your two tokens in:

```bash
SLACK_BOT_TOKEN=xoxb-...   # the Bot User OAuth Token from "Install App"
SLACK_APP_TOKEN=xapp-...   # the App-Level Token you generated
```

Bun auto-loads `.env` when you run the daemon, so that's all the wiring needed for foreground use. (For launchd, put the same values into the plist's `EnvironmentVariables` block instead — see `com.example.slack-bus.plist.template`.)

### 3. Run the daemon

For a quick foreground test:

```bash
SLACK_BUS_INSTANCE=default SLACK_BUS_PORT=42001 bun bus-mcp.ts
```

You should see:
```
[bus:default] Slack Socket Mode connected. bot_user_id=U...
[bus:default] listening on http://localhost:42001/mcp
```

For background, launchd-managed:
1. Copy `com.example.slack-bus.plist.template` to `~/Library/LaunchAgents/com.<you>.slack-bus.plist`.
2. Edit the placeholders (label, instance, port, paths).
3. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<you>.slack-bus.plist`.

### 4. Wire it into Claude Code

Copy `.mcp.example.json` (in this repo) into your project's `.mcp.json`, or into `~/.mcp.json` for all projects. It looks like:

```json
{
  "mcpServers": {
    "slack-bus": {
      "type": "http",
      "url": "http://localhost:42001/mcp"
    }
  }
}
```

Launch Claude Code with the dev-channels flag:

```bash
claude --dangerously-load-development-channels server:slack-bus
```

In the session, ask Claude to `post_message` to a channel. Reply in Slack. The reply should arrive as a system reminder. That's the whole loop.

## Using it daily

The long launch invocation gets old. Most folks wrap it in a shell function around a Claude Code custom agent:

```bash
# ~/.zshrc
standup() {
  cd ~/work/notes
  claude --dangerously-skip-permissions \
    --dangerously-load-development-channels server:slack-bus \
    --agent standup-assistant
}
```

`standup-assistant` is a named agent definition at `~/.claude/agents/standup-assistant.md` with its own system prompt — telling Claude what to pull from Linear, the channels to post in, your voice and tone, how to handle replies.

The shape of a day:

- **Morning** — "post my standup in #standups." Claude writes a tight summary in your voice, posts it, auto-subscribes to the thread.
- **Mid-day** — teammate replies *"wait, what about the migration?"* The reply arrives as a system reminder in the same Claude session where you're actually doing the work — so Claude answers from the real context, not from the compressed Slack post.
- **EOD** — "post EOD update." Same loop.

That's the leverage. Slack messages are compressed by nature — short, fragmented, lots of detail dropped. Your Claude session isn't compressed — it's the full source. When the team asks follow-ups via Slack, the answer comes back from the source, not from a re-read of the broadcast.

## Tool surface

22 tools as of v0.5.0. Defined inline in `bus-mcp.ts` under `const TOOLS` — adding one is appending an entry to that array.

**Messaging** — `post_message`, `update_message`, `delete_message`, `add_reaction`. `post_message` accepts Block Kit `blocks` for rich layouts and `text` as a notification fallback.

**Subscription** — `subscribe_channel` (every new message in a channel), `subscribe_thread` (replies in a specific thread). Top-level `post_message` auto-subscribes you to the resulting thread unless you pass `auto_subscribe: false`. Reactions on subscribed messages (and on any message in a subscribed channel) are auto-routed too, as `kind: "reaction"` and `"reaction_removed"`.

**Streaming** — `start_stream` / `append_stream` / `stop_stream` for typing-animation messages. `stop_stream` accepts final Block Kit blocks that render after the streamed text.

**Thread status** — `set_thread_status` for rotating loading indicators (`"thinking..."`, `"searching..."`). Auto-clears after two minutes or when a reply is sent.

**Channel management** — `create_channel`, `join_channel`, `invite_users`, `pin_message`.

**Files** — `upload_file` (any file type — images, mp4/mov video, audio, PDF; Slack inline-renders most), `upload_text` (in-memory text content as an attached file with syntax highlighting), `get_file_from_slack` (download by file ID).

**Lookups** — `get_channel_context` (recent messages with user names resolved; `thread_ts` scopes to a thread's replies), `get_user_info`, `list_channels`, `list_users`. Most lookup tools accept `format: "compact"` (default) to strip Slack API bloat.

**Introspection** — `bus_status` returns the daemon's current state: uptime, bot identity, every active session and its subscriptions. Useful for debugging "did my notification arrive?" or confirming what this session is currently watching.

## Known rough edges

- **Subscriptions are ephemeral.** They live in memory and die when the session disconnects. If you restart Claude mid-thread, you lose the subscription. Re-post or `subscribe_thread` to recover.
- **One Slack app per Socket Mode connection.** If you already run another bot on the same app token (e.g. a [joel-bot](https://github.com/anthropics/claude-code)-style channel bot), they'll fight for the socket. Use a separate Slack app for slack-bus.
- **Bot self-posts are filtered.** The bus's `message.user === botUserId` guard prevents echo loops, which means you can't validate the inbound path by having Claude post and "see" its own message. A real human (or second Slack identity) has to post for routing to fire.
- **Idle SSE behavior is unverified.** Observed once: a session that sat idle ~11 min before posting didn't receive the reply notification. Re-test on a fresh session worked. Probably a client-side SSE drop. Instrumentation now logs every notification dispatch outcome — if you see this, the bus log will tell you whether it dispatched OK (client-side) or failed (bus-side).
- **No auth on the localhost MCP endpoint.** Anything on your machine that can reach `localhost:<port>` can use your Slack tokens via this MCP. macOS limits this to your user. Don't bind to non-loopback addresses.

## Architecture notes

If you're curious about *why* this shape:

- The MCP protocol supports both stdio (one subprocess per session) and Streamable HTTP (one server, many sessions). slack-bus uses HTTP because the daemon has to hold the Slack Socket Mode WebSocket — that connection is exclusive per Slack app token, so a stdio model would mean one Slack-connection-holding subprocess per session, which doesn't work.
- Session identity comes from the MCP protocol's `mcp-session-id` header — generated server-side by `WebStandardStreamableHTTPServerTransport.sessionIdGenerator`. Each Claude Code session gets a unique routing key for free.
- `Bun.serve`'s default `idleTimeout` is 10 seconds, which would kill the SSE streams MCP uses for server→client notifications. The daemon sets `idleTimeout: 0`. Don't remove this.

## License

MIT. Build whatever, no warranty.
