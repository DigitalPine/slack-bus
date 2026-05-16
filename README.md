# slack-bus

**Be in Slack while you're in Claude.**

Post to Slack from Claude. Your team replies in the thread. Their replies route back to Claude as system reminders mid-turn — Claude reads them, writes a response, posts it. To your team it looks like a normal Slack conversation with you. You never leave your editor.

Async standups. Ticket shaping. Drive-by team Q&A. The conversation lives in Slack where your team already is; you live in Claude; slack-bus is the bridge.

https://github.com/DigitalPine/slack-bus/raw/main/docs/demo.mp4

The framing most people land on: make the bot **"<Your Name> (Claude)"**. The bot *is* you, with Claude driving. Your teammates talk to it as if it were you, because for the purposes of that conversation, it is.

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

Then:
- Under **Basic Information** → **App-Level Tokens** → generate one with `connections:write` scope. This is your `SLACK_APP_TOKEN` (`xapp-...`).
- Under **Install App** → install to workspace → copy the **Bot User OAuth Token**. This is your `SLACK_BOT_TOKEN` (`xoxb-...`).
- Under **Socket Mode** → confirm it's enabled.

### 2. Configure tokens

Export both tokens in your shell (e.g. `~/.zshrc`):

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
```

### 3. Install dependencies

```bash
git clone https://github.com/DigitalPine/slack-bus.git ~/Code/slack-bus
cd ~/Code/slack-bus
bun install
```

### 4. Run the daemon

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

### 5. Wire it into Claude Code

Add to your project's `.mcp.json` (or `~/.mcp.json` global):

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

## Tool surface

**Messaging** — `post_message`, `update_message`, `delete_message`, `add_reaction`

**Subscription** — `subscribe_channel` (every new message in a channel), `subscribe_thread` (replies in a specific thread). Top-level `post_message` auto-subscribes you to the resulting thread.

**Lookups** — `get_channel_context` (recent messages with user names resolved), `get_user_info`, `list_channels`, `list_users`.

Tools defined inline in `bus-mcp.ts` under `const TOOLS`. Adding a tool is appending an entry to that array.

## What's not here yet

- Streaming tools (typing-animation messages — `start_stream` / `append_stream` / `stop_stream`)
- `set_thread_status` (rotating status indicators like "thinking...")
- File operations (`upload_image`, `upload_snippet`, `get_image_from_slack`)
- Channel management (`pin_message`, `create_channel`, `invite_users`, `join_channel`)

These are straightforward to add by following the existing pattern in `bus-mcp.ts`. Open a PR or use them as exercises if you're learning MCP.

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
