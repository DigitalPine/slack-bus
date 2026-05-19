#!/usr/bin/env bun
/**
 * slack-bus — merged daemon (HTTP MCP server + Slack Socket Mode).
 *
 * Single process per Slack org. Holds the Slack Socket Mode WebSocket,
 * exposes Slack Web API tools (post, react, look-up...) AND subscription
 * tools (subscribe_channel/_thread) over Streamable HTTP MCP transport.
 * Routes inbound Slack events to subscribed Claude Code sessions as
 * `notifications/claude/channel` system reminders.
 *
 * Replaces the prior bus.ts (Unix-socket daemon) + shim.ts (stdio MCP adapter)
 * + slack-api-mcp (separate posting MCP) trio with a single artifact.
 *
 * Env:
 *   SLACK_BUS_INSTANCE   — e.g. "digitalpine", "onlook" (used for log path)
 *   SLACK_BUS_PORT       — localhost port to bind, e.g. 42001
 *   SLACK_BOT_TOKEN      — xoxb-...
 *   SLACK_APP_TOKEN      — xapp-... (for Socket Mode)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { App } from "@slack/bolt";
import type {
	GenericMessageEvent,
	ReactionAddedEvent,
	ReactionRemovedEvent,
} from "@slack/types";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

// ─── Config ───────────────────────────────────────────────────────────────────

const INSTANCE = process.env.SLACK_BUS_INSTANCE;
if (!INSTANCE) {
	throw new Error(
		"SLACK_BUS_INSTANCE is required (e.g. 'digitalpine', 'onlook')",
	);
}
const PORT = Number(process.env.SLACK_BUS_PORT);
if (!Number.isInteger(PORT) || PORT <= 0) {
	throw new Error("SLACK_BUS_PORT must be a positive integer (e.g. 42001)");
}
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
if (!SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is required");
if (!SLACK_APP_TOKEN) throw new Error("SLACK_APP_TOKEN is required");

const LOG_FILE = `/tmp/slack-bus-${INSTANCE}.log`;

function log(msg: string) {
	const line = `[${new Date().toISOString()}] [bus:${INSTANCE}] ${msg}\n`;
	try {
		appendFileSync(LOG_FILE, line);
	} catch {}
	process.stdout.write(line);
}

// ─── Caches ───────────────────────────────────────────────────────────────────
// Light TTL+LRU caches for stable lookups (users, channels).

class SimpleCache<T> {
	private cache = new Map<string, { data: T; expires: number; touched: number }>();
	constructor(private maxSize = 500, private ttlMs = 300_000) {}
	get(key: string): T | null {
		const entry = this.cache.get(key);
		if (!entry) return null;
		if (Date.now() > entry.expires) {
			this.cache.delete(key);
			return null;
		}
		entry.touched = Date.now();
		return entry.data;
	}
	set(key: string, data: T) {
		if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
			// LRU eviction
			let oldestKey: string | undefined;
			let oldest = Infinity;
			for (const [k, v] of this.cache) {
				if (v.touched < oldest) {
					oldest = v.touched;
					oldestKey = k;
				}
			}
			if (oldestKey) this.cache.delete(oldestKey);
		}
		this.cache.set(key, { data, expires: Date.now() + this.ttlMs, touched: Date.now() });
	}
}

const userCache = new SimpleCache<any>(500);
const channelCache = new SimpleCache<any>(200);

// ─── Compact formatters (port from slack-api-mcp/lib/format-helpers) ──────────

function compactMessage(msg: any) {
	const out: any = {
		ts: msg.ts,
		text: msg.text ?? "",
		type: msg.type ?? "message",
	};
	if (msg.user) out.user = msg.user;
	if (msg.bot_id) out.bot_id = msg.bot_id;
	if (msg.user_name) out.user_name = msg.user_name;
	if (msg.thread_ts) out.thread_ts = msg.thread_ts;
	if (Array.isArray(msg.reactions)) {
		out.reactions = msg.reactions.map((r: any) => ({
			name: r.name,
			count: r.count ?? (r.users?.length ?? 0),
		}));
	}
	return out;
}

function compactChannel(channel: any) {
	const out: any = {
		id: channel.id,
		name: channel.name,
		is_private: !!channel.is_private,
		is_member: !!channel.is_member,
		num_members: channel.num_members ?? 0,
	};
	const topic = channel.topic?.value || channel.purpose?.value;
	if (topic?.trim()) out.topic = topic;
	return out;
}

function compactUser(user: any) {
	const profile = user.profile ?? {};
	const out: any = {
		id: user.id,
		name: user.name || profile.display_name || "",
		real_name: user.real_name || profile.real_name || "",
	};
	if (profile.title) out.title = profile.title;
	if (profile.status_text) out.status_text = profile.status_text;
	if (profile.status_emoji) out.status_emoji = profile.status_emoji;
	if (profile.image_72) out.avatar = profile.image_72;
	return out;
}

// ─── Slack ────────────────────────────────────────────────────────────────────

const slackApp = new App({
	token: SLACK_BOT_TOKEN,
	appToken: SLACK_APP_TOKEN,
	socketMode: true,
	logLevel: "ERROR" as never,
});
const slack = slackApp.client;

let botUserId: string | undefined;
async function getBotUserId(): Promise<string> {
	if (!botUserId) {
		const auth = await slack.auth.test({ token: SLACK_BOT_TOKEN });
		botUserId = auth.user_id as string;
	}
	return botUserId;
}

async function getChannelName(channelId: string): Promise<string> {
	const cached = channelCache.get(channelId);
	if (cached?.name) return cached.name;
	try {
		const info = await slack.conversations.info({ channel: channelId });
		const ch = info.channel;
		if (ch?.id) channelCache.set(ch.id, ch);
		return ch?.name ?? channelId;
	} catch {
		return channelId;
	}
}

async function getUserName(userId: string): Promise<string> {
	const cached = userCache.get(userId);
	if (cached) return cached.real_name ?? cached.profile?.real_name ?? cached.name ?? userId;
	try {
		const info = await slack.users.info({ user: userId });
		if (info.user) userCache.set(userId, info.user);
		return info.user?.real_name ?? info.user?.profile?.real_name ?? info.user?.name ?? userId;
	} catch {
		return userId;
	}
}

// ─── Sessions & routing ───────────────────────────────────────────────────────

type Session = {
	id: string;
	server: Server;
	transport: WebStandardStreamableHTTPServerTransport;
	threads: Set<string>; // "channel:thread_ts"
	channels: Set<string>; // "channel"
};

const sessions = new Map<string, Session>();

function threadKey(channel: string, ts: string): string {
	return `${channel}:${ts}`;
}

// Slack inbound event router. Same logic as the unix-socket bus, but pushes
// via the per-session MCP transport instead of a socket frame.
slackApp.message(async ({ message }) => {
	// Bolt's `message` event is a union over many subtypes; we only route
	// plain user messages. The `subtype === undefined` discriminator narrows
	// to GenericMessageEvent, which carries channel/user/ts/thread_ts cleanly.
	if (message.subtype !== undefined) return;
	const m = message as GenericMessageEvent;
	if (!m.text || !m.user) return;

	const myId = await getBotUserId();
	if (m.user === myId) return;

	const channelId = m.channel;
	const threadTs = m.thread_ts;
	const isReply = !!threadTs;
	const tKey = isReply ? threadKey(channelId, threadTs) : null;

	const matches: Array<{ session: Session; kind: "thread_reply" | "channel_message" }> = [];
	for (const session of sessions.values()) {
		if (tKey && session.threads.has(tKey)) {
			matches.push({ session, kind: "thread_reply" });
		} else if (session.channels.has(channelId)) {
			matches.push({ session, kind: "channel_message" });
		}
	}
	if (matches.length === 0) return;

	const [userName, channelName] = await Promise.all([
		getUserName(m.user),
		getChannelName(channelId),
	]);

	log(
		`${isReply ? "reply" : "message"} in ${channelName}${threadTs ? "/" + threadTs : ""} → ${matches.length} session(s)`,
	);

	for (const { session, kind } of matches) {
		// thread_ts is only meaningful for actual thread replies. For top-level
		// channel messages, omit it so Claude doesn't pass the message's own ts
		// to get_channel_context as a thread parent (which returns just that
		// single message and looks like an empty thread).
		const meta: Record<string, unknown> = {
			source: "slack-bus",
			kind,
			channel_id: channelId,
			channel_name: channelName,
			ts: m.ts,
			user_id: m.user,
			user_name: userName,
		};
		if (threadTs) meta.thread_ts = threadTs;

		session.server
			.notification({
				method: "notifications/claude/channel",
				params: {
					content: m.text,
					meta,
				},
			})
			.then(() =>
				log(`notification → ${session.id} dispatched OK (kind=${kind})`),
			)
			.catch((err) =>
				log(`notification → ${session.id} dispatch FAILED: ${err}`),
			);
	}
});

// Reaction routing — auto-delivered to sessions subscribed to the target
// message's thread (parent ts match) or its channel. Bot's own reactions
// are filtered to avoid echo loops.
//
// Limitation: when the reaction is on a *reply inside* a thread we're
// subscribed to (not on the parent), routing won't match — we'd need a
// conversations.replies call per reaction to resolve the parent ts. Acceptable
// for the v1 use case (reactions on the bot's own posts and on parent messages).
async function routeReactionEvent(
	event: ReactionAddedEvent | ReactionRemovedEvent,
	kind: "reaction" | "reaction_removed",
): Promise<void> {
	if (event.item.type !== "message") return;
	const myId = await getBotUserId();
	if (event.user === myId) return;

	const channelId = event.item.channel;
	const itemTs = event.item.ts;
	const tKey = threadKey(channelId, itemTs);

	const matches: Session[] = [];
	for (const session of sessions.values()) {
		if (session.threads.has(tKey) || session.channels.has(channelId)) {
			matches.push(session);
		}
	}
	if (matches.length === 0) return;

	const [userName, channelName] = await Promise.all([
		getUserName(event.user),
		getChannelName(channelId),
	]);

	log(
		`${kind} :${event.reaction}: in ${channelName}/${itemTs} by ${userName} → ${matches.length} session(s)`,
	);

	const verb = kind === "reaction" ? "added" : "removed";
	for (const session of matches) {
		session.server
			.notification({
				method: "notifications/claude/channel",
				params: {
					content: `Reaction :${event.reaction}: ${verb} by ${userName} on message ts=${itemTs} in ${channelName}.`,
					meta: {
						source: "slack-bus",
						kind,
						channel_id: channelId,
						channel_name: channelName,
						reaction: event.reaction,
						item_ts: itemTs,
						item_user: event.item_user,
						ts: event.event_ts,
						user_id: event.user,
						user_name: userName,
					},
				},
			})
			.then(() =>
				log(`notification → ${session.id} dispatched OK (kind=${kind})`),
			)
			.catch((err) =>
				log(`notification → ${session.id} dispatch FAILED: ${err}`),
			);
	}
}

slackApp.event("reaction_added", async ({ event }) => {
	await routeReactionEvent(event, "reaction");
});

slackApp.event("reaction_removed", async ({ event }) => {
	await routeReactionEvent(event, "reaction_removed");
});

// ─── Tool surface ─────────────────────────────────────────────────────────────
// One registry, applied to each per-session Server (handlers close over session).

type Tool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handler: (session: Session, args: Record<string, any>) => Promise<string>;
};

const TOOLS: Tool[] = [
	// ─── Messaging ────────────────────────────────────────────────────────────
	{
		name: "post_message",
		description:
			"Post a message to a Slack channel or thread. Accepts Block Kit blocks for rich content; pass `text` as a notification fallback. When posting top-level (no thread_ts), this session is auto-subscribed to BOTH replies in the resulting thread AND reactions on the posted message — they'll arrive as `notifications/claude/channel` system reminders (kinds `thread_reply`, `reaction`, `reaction_removed`).",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID (e.g. C0AK69QKDL1)." },
				blocks: {
					type: "array",
					items: { type: "object" },
					description: "Block Kit blocks array. Required for rich content.",
				},
				text: {
					type: "string",
					description:
						"Fallback text for notifications (1-2 sentences). Visible only when blocks aren't supported by the client. If blocks is omitted, this is the message body.",
				},
				thread_ts: {
					type: "string",
					description: "Reply within an existing thread by passing its parent ts.",
				},
				unfurl_links: { type: "boolean" },
				unfurl_media: { type: "boolean" },
				auto_subscribe: {
					type: "boolean",
					description:
						"Default true for top-level posts (subscribes this session to replies). Set false to post without subscribing.",
				},
			},
			required: ["channel"],
		},
		handler: async (session, args) => {
			const { channel, blocks, text, thread_ts, unfurl_links, unfurl_media } = args;
			const auto = args.auto_subscribe !== false;

			if ((!blocks || blocks.length === 0) && !text) {
				throw new Error("post_message requires either `blocks` or `text`.");
			}

			const res = await slack.chat.postMessage({
				channel,
				blocks: blocks?.length ? blocks : undefined,
				text: text ?? "(no text)",
				thread_ts,
				unfurl_links,
				unfurl_media,
			});
			const ts = res.ts;
			if (!ts) throw new Error("chat.postMessage returned no ts");

			let note = `Posted. channel=${channel} ts=${ts}`;
			if (!thread_ts && auto) {
				session.threads.add(threadKey(channel, ts));
				note += `. Auto-subscribed to replies in this thread.`;
				log(`session ${session.id} posted to ${channel}, auto-subscribed to thread ${ts}`);
			} else if (thread_ts) {
				note += ` (in thread ${thread_ts})`;
				log(`session ${session.id} replied in ${channel}/${thread_ts} (ts ${ts})`);
			} else {
				log(`session ${session.id} posted to ${channel} ts=${ts}`);
			}
			return note;
		},
	},
	{
		name: "update_message",
		description: "Edit an existing Slack message. Accepts Block Kit blocks; pass `text` as fallback.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID." },
				ts: { type: "string", description: "Timestamp of the message to edit." },
				blocks: { type: "array", items: { type: "object" } },
				text: { type: "string" },
			},
			required: ["channel", "ts"],
		},
		handler: async (_session, args) => {
			const { channel, ts, blocks, text } = args;
			if ((!blocks || blocks.length === 0) && !text) {
				throw new Error("update_message requires either `blocks` or `text`.");
			}
			await slack.chat.update({
				channel,
				ts,
				blocks: blocks?.length ? blocks : undefined,
				text: text ?? "(no text)",
			});
			return `Updated ${channel} ts=${ts}.`;
		},
	},
	{
		name: "delete_message",
		description: "Delete a Slack message.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID." },
				ts: { type: "string", description: "Timestamp of the message to delete." },
			},
			required: ["channel", "ts"],
		},
		handler: async (_session, args) => {
			await slack.chat.delete({ channel: args.channel, ts: args.ts });
			return `Deleted ${args.channel} ts=${args.ts}.`;
		},
	},
	{
		name: "add_reaction",
		description: "Add an emoji reaction to a Slack message.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID." },
				timestamp: { type: "string", description: "Message timestamp." },
				name: { type: "string", description: "Emoji name without colons (e.g. 'thumbsup')." },
			},
			required: ["channel", "timestamp", "name"],
		},
		handler: async (_session, args) => {
			await slack.reactions.add({
				channel: args.channel,
				timestamp: args.timestamp,
				name: args.name,
			});
			return `Reaction :${args.name}: added.`;
		},
	},

	// ─── Subscription ─────────────────────────────────────────────────────────
	{
		name: "subscribe_channel",
		description:
			"Subscribe this session to ALL new messages in a channel. Each new message arrives as a `notifications/claude/channel` system reminder with kind=channel_message. Session-scoped — dies when this session ends.",
		inputSchema: {
			type: "object",
			properties: {
				channel_id: { type: "string", description: "Channel ID to subscribe to." },
			},
			required: ["channel_id"],
		},
		handler: async (session, args) => {
			session.channels.add(args.channel_id);
			log(`session ${session.id} subscribed to channel ${args.channel_id} (now ${session.channels.size})`);
			return `Subscribed to channel ${args.channel_id} for the lifetime of this session.`;
		},
	},
	{
		name: "subscribe_thread",
		description:
			"Subscribe this session to replies in a specific thread. Use when you want to follow a thread you didn't post yourself. Replies arrive as `notifications/claude/channel` reminders with kind=thread_reply.",
		inputSchema: {
			type: "object",
			properties: {
				channel_id: { type: "string", description: "Channel ID." },
				thread_ts: { type: "string", description: "Thread parent message ts." },
			},
			required: ["channel_id", "thread_ts"],
		},
		handler: async (session, args) => {
			session.threads.add(threadKey(args.channel_id, args.thread_ts));
			log(
				`session ${session.id} subscribed to thread ${args.channel_id}/${args.thread_ts} (now ${session.threads.size})`,
			);
			return `Subscribed to thread ${args.channel_id}/${args.thread_ts}.`;
		},
	},

	// ─── Streaming ────────────────────────────────────────────────────────────
	{
		name: "start_stream",
		description:
			"Start a streaming message in a thread. Returns a ts used by `append_stream` and `stop_stream`. Streaming messages render with a typing animation in Slack.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID to stream in." },
				thread_ts: {
					type: "string",
					description: "Thread parent ts. Streaming must be in a thread.",
				},
				markdown_text: {
					type: "string",
					description: "Initial markdown text (max 12,000 chars).",
				},
				recipient_user_id: {
					type: "string",
					description:
						"User ID to receive the stream. Required when streaming in channels, not needed for DMs.",
				},
				recipient_team_id: {
					type: "string",
					description: "Team ID associated with recipient_user_id. Required with recipient_user_id.",
				},
			},
			required: ["channel", "thread_ts"],
		},
		handler: async (_session, args) => {
			const r = await slack.chat.startStream({
				channel: args.channel,
				thread_ts: args.thread_ts,
				markdown_text: args.markdown_text,
				recipient_user_id: args.recipient_user_id,
				recipient_team_id: args.recipient_team_id,
			});
			return JSON.stringify({ ok: true, channel: r.channel, ts: r.ts });
		},
	},
	{
		name: "append_stream",
		description:
			"Append text to an active streaming message. Call repeatedly to build the message incrementally. Rate limit: 100+/min.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID of the streaming message." },
				ts: { type: "string", description: "ts returned by `start_stream`." },
				markdown_text: {
					type: "string",
					description: "Markdown text to append (max 12,000 chars).",
				},
			},
			required: ["channel", "ts", "markdown_text"],
		},
		handler: async (_session, args) => {
			const r = await slack.chat.appendStream({
				channel: args.channel,
				ts: args.ts,
				markdown_text: args.markdown_text,
			});
			return JSON.stringify({ ok: true, channel: r.channel, ts: r.ts });
		},
	},
	{
		name: "stop_stream",
		description:
			"Finalize a streaming message. Ends the typing animation. Can include final text and Block Kit blocks that render after the streamed content.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID of the streaming message." },
				ts: { type: "string", description: "ts returned by `start_stream`." },
				markdown_text: {
					type: "string",
					description: "Final markdown text to append before stopping (max 12,000 chars).",
				},
				blocks: {
					type: "array",
					items: { type: "object" },
					description: "Block Kit blocks to render at the end (max 50).",
				},
			},
			required: ["channel", "ts"],
		},
		handler: async (_session, args) => {
			const r = await slack.chat.stopStream({
				channel: args.channel,
				ts: args.ts,
				markdown_text: args.markdown_text,
				blocks: args.blocks,
			});
			return JSON.stringify({ ok: true, channel: r.channel, ts: r.ts });
		},
	},

	// ─── Thread status ────────────────────────────────────────────────────────
	{
		name: "set_thread_status",
		description:
			'Set a rotating status indicator on a thread (e.g. "thinking...", "searching..."). Displays as "<App Name> <status>". Pass empty string to clear. Auto-clears after 2 minutes or when a reply is sent.',
		inputSchema: {
			type: "object",
			properties: {
				channel_id: { type: "string", description: "Channel ID containing the thread." },
				thread_ts: { type: "string", description: "Thread ts to set status on." },
				status: {
					type: "string",
					description: "Status text. Empty string clears.",
				},
				loading_messages: {
					type: "array",
					items: { type: "string" },
					description:
						"Up to 10 messages Slack rotates through as a loading indicator (e.g. ['thinking...', 'searching...']).",
				},
			},
			required: ["channel_id", "thread_ts", "status"],
		},
		handler: async (_session, args) => {
			await slack.assistant.threads.setStatus({
				channel_id: args.channel_id,
				thread_ts: args.thread_ts,
				status: args.status,
				loading_messages: args.loading_messages,
			});
			return args.status
				? `Status set: "${args.status}"${
						args.loading_messages
							? ` (rotating through ${args.loading_messages.length} messages)`
							: ""
					}`
				: "Status cleared";
		},
	},

	// ─── Channel management ───────────────────────────────────────────────────
	{
		name: "create_channel",
		description: "Create a new Slack channel. Returns the channel ID and details.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description:
						"Channel name (lowercase letters, numbers, hyphens, underscores only, max 80 chars).",
				},
				is_private: {
					type: "boolean",
					description: "Create as private channel (default: false).",
				},
			},
			required: ["name"],
		},
		handler: async (_session, args) => {
			if (!/^[a-z0-9-_]+$/.test(args.name) || args.name.length > 80) {
				throw new Error("name must be lowercase letters, numbers, hyphens, underscores; max 80 chars");
			}
			const r = await slack.conversations.create({
				name: args.name,
				is_private: !!args.is_private,
			});
			if (!r.ok || !r.channel) {
				throw new Error(`create_channel failed: ${r.error ?? "unknown"}`);
			}
			return JSON.stringify(
				{
					success: true,
					channel: {
						id: r.channel.id,
						name: r.channel.name,
						is_private: r.channel.is_private,
					},
				},
				null,
				2,
			);
		},
	},
	{
		name: "join_channel",
		description: "Join a Slack channel. Bot must have channels:join scope.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID to join." },
			},
			required: ["channel"],
		},
		handler: async (_session, args) => {
			const r = await slack.conversations.join({ channel: args.channel });
			if (!r.ok || !r.channel) {
				throw new Error(`join_channel failed: ${r.error ?? "unknown"}`);
			}
			return JSON.stringify(
				{ success: true, channel: { id: r.channel.id, name: r.channel.name } },
				null,
				2,
			);
		},
	},
	{
		name: "invite_users",
		description: "Invite one or more users to a channel.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID to invite users to." },
				users: {
					type: "array",
					items: { type: "string" },
					description: "User IDs to invite (e.g. ['U123','U456']).",
				},
			},
			required: ["channel", "users"],
		},
		handler: async (_session, args) => {
			const users: string[] = args.users ?? [];
			if (users.length === 0) throw new Error("at least one user ID is required");
			const r = await slack.conversations.invite({
				channel: args.channel,
				users: users.join(","),
			});
			if (!r.ok) throw new Error(`invite_users failed: ${r.error ?? "unknown"}`);
			return JSON.stringify(
				{ success: true, channel: r.channel?.id ?? args.channel, invited_users: users },
				null,
				2,
			);
		},
	},
	{
		name: "pin_message",
		description: "Pin a message to a channel.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID." },
				timestamp: { type: "string", description: "Message ts to pin." },
			},
			required: ["channel", "timestamp"],
		},
		handler: async (_session, args) => {
			await slack.pins.add({ channel: args.channel, timestamp: args.timestamp });
			return `Pinned ${args.channel} ts=${args.timestamp}.`;
		},
	},

	// ─── Files ────────────────────────────────────────────────────────────────
	{
		name: "upload_image",
		description:
			"Upload an image to Slack. If `channel` is given, posts it; otherwise just uploads and returns a file ID for use in Block Kit image blocks.",
		inputSchema: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Absolute path to image file (PNG, JPEG, JPG, GIF).",
				},
				channel: {
					type: "string",
					description: "Channel ID to post to (optional). Omit to just upload.",
				},
				initial_comment: {
					type: "string",
					description: "Comment posted with the image.",
				},
				thread_ts: {
					type: "string",
					description: "Thread ts (requires channel).",
				},
				title: { type: "string", description: "Title for the image." },
				alt_text: { type: "string", description: "Alt text for accessibility." },
			},
			required: ["file_path"],
		},
		handler: async (_session, args) => {
			if (args.thread_ts && !args.channel) {
				throw new Error("thread_ts requires channel to be specified");
			}
			const fileBuffer = await readFile(args.file_path);
			const filename = String(args.file_path).split("/").pop() || "image.png";
			const result = await slack.files.uploadV2({
				file: fileBuffer,
				filename,
				title: args.title,
				alt_text: args.alt_text,
				channel_id: args.channel,
				initial_comment: args.initial_comment,
				thread_ts: args.thread_ts,
			});
			// The uploadV2 helper wraps the response in an extra layer the
			// declared WebAPICallResult type doesn't capture: the file ID lives at
			// result.files[0].files[0].id. Narrow with a local type to avoid `any`.
			type UploadV2Result = { files?: Array<{ files?: Array<{ id?: string }> }> };
			const fileId = (result as UploadV2Result).files?.[0]?.files?.[0]?.id;
			if (!fileId) {
				throw new Error("Upload succeeded but no file ID returned");
			}

			let response = `Image uploaded. file_id=${fileId} filename=${filename}`;
			if (args.channel) {
				response += `\nPosted to ${args.channel}${args.thread_ts ? ` (in thread)` : ""}`;
			} else {
				response += `\n\nTo embed in a message, use this image block:\n${JSON.stringify(
					{
						type: "image",
						slack_file: { id: fileId },
						alt_text: args.alt_text || filename,
					},
					null,
					2,
				)}`;
			}
			return response;
		},
	},
	{
		name: "get_image_from_slack",
		description:
			"Download a Slack-uploaded image by file ID. Returns the local file path under /tmp.",
		inputSchema: {
			type: "object",
			properties: {
				file_id: { type: "string", description: "Slack file ID (e.g. F09LN15EWCD)." },
			},
			required: ["file_id"],
		},
		handler: async (_session, args) => {
			const info = await slack.files.info({ file: args.file_id });
			const file = info.file;
			if (!file || !file.url_private) {
				throw new Error(`File not found: ${args.file_id}`);
			}
			const timestamp = Date.now();
			const ext = file.filetype || "png";
			const localPath = `/tmp/slack-image-${timestamp}.${ext}`;

			// Race: freshly-uploaded files sometimes 302 to a login interstitial
			// for a brief window after upload completes. Slack returns HTML
			// instead of the file bytes. Retry with backoff and validate the
			// content-type before writing.
			const backoffsMs = [0, 250, 750, 1500];
			let buffer: Buffer | null = null;
			let lastIssue = "";
			for (const wait of backoffsMs) {
				if (wait > 0) await new Promise((r) => setTimeout(r, wait));
				const res = await fetch(file.url_private, {
					headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
				});
				if (!res.ok) {
					lastIssue = `HTTP ${res.status} ${res.statusText}`;
					continue;
				}
				const ct = res.headers.get("content-type") ?? "";
				if (ct.startsWith("text/html")) {
					lastIssue = `Slack returned HTML (likely auth interstitial — file not yet ready)`;
					continue;
				}
				buffer = Buffer.from(await res.arrayBuffer());
				if (typeof file.size === "number" && buffer.length !== file.size) {
					lastIssue = `Size mismatch — expected ${file.size}, got ${buffer.length}`;
					buffer = null;
					continue;
				}
				break;
			}
			if (!buffer) {
				throw new Error(`Download failed after ${backoffsMs.length} attempts: ${lastIssue}`);
			}

			await writeFile(localPath, buffer);
			return `Image downloaded to: ${localPath}\nName: ${file.name}\nType: ${file.mimetype}\nSize: ${file.size} bytes`;
		},
	},
	{
		name: "upload_snippet",
		description: "Upload a text snippet/file to Slack (up to ~1MB).",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID." },
				content: { type: "string", description: "Text content to upload." },
				filename: { type: "string", description: "Filename (e.g. 'code.js')." },
				title: { type: "string", description: "Title (default: filename)." },
				thread_ts: { type: "string", description: "Thread ts." },
			},
			required: ["channel", "content", "filename"],
		},
		handler: async (_session, args) => {
			const snippetTitle = args.title || args.filename;
			const contentLength = Buffer.byteLength(args.content, "utf-8");
			const urlRes = await slack.files.getUploadURLExternal({
				filename: args.filename,
				length: contentLength,
			});
			if (!urlRes.upload_url || !urlRes.file_id) {
				throw new Error("Failed to get upload URL or file ID");
			}
			const upload = await fetch(urlRes.upload_url, {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: args.content,
			});
			if (!upload.ok) {
				throw new Error(`Upload failed: ${upload.statusText}`);
			}
			await slack.files.completeUploadExternal({
				files: [{ id: urlRes.file_id, title: snippetTitle }],
				channel_id: args.channel,
				thread_ts: args.thread_ts,
			});
			return `Snippet uploaded: ${args.filename} (${contentLength} bytes)`;
		},
	},

	// ─── Context / lookups ────────────────────────────────────────────────────
	{
		name: "get_channel_context",
		description:
			"Read Slack conversation history. Two modes:\n\n" +
				"• **Thread mode** (pass `thread_ts`): returns ONLY that thread's messages — parent + replies. Use this whenever the user references a specific thread or you're responding to a `thread_reply` notification. Look for `meta.thread_ts` in recent `notifications/claude/channel` system reminders, or extract from a Slack thread URL.\n\n" +
				"• **Channel mode** (omit `thread_ts`): returns recent top-level activity in the channel.\n\n" +
				"Prefer thread mode any time you have a real `thread_ts` available — channel mode pulls broad noise when you only wanted one conversation. Returns compact JSON with user names resolved.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID." },
				thread_ts: {
					type: "string",
					description:
						"Thread parent ts. When set, the tool ignores `exclude_threads` and returns strictly that thread's messages (parent + replies). Source from `meta.thread_ts` on a thread_reply notification, or from a Slack thread permalink. Do NOT pass a non-thread message's ts here — it will return only that single message.",
				},
				limit: {
					type: "number",
					description:
						"Max messages to return (default 10). For long threads, raise this — Slack returns the OLDEST N replies first, so a low limit on a deep thread misses the recent context.",
				},
				exclude_threads: {
					type: "boolean",
					description:
						"Channel-mode only. When true, drops messages that are replies inside threads, returning just top-level posts. Has no effect in thread mode. Default false.",
				},
				format: { type: "string", enum: ["compact", "full"] },
			},
			required: ["channel"],
		},
		handler: async (_session, args) => {
			const limit = args.limit ?? 10;
			const exclude = !!args.exclude_threads;
			const fmt = args.format ?? "compact";
			let msgs: any[] = [];

			if (args.thread_ts) {
				// Thread mode: scope strictly to the thread's replies (DIG-197).
				// Slack returns the parent + replies; we return them as-is, capped by limit.
				const r = await slack.conversations.replies({
					channel: args.channel,
					ts: args.thread_ts,
					limit,
				});
				msgs = (r.messages ?? []).slice(0, limit);
			} else {
				// Channel mode: recent messages, optionally excluding threaded replies.
				const fetchLimit = exclude ? limit * 5 : limit;
				const r = await slack.conversations.history({
					channel: args.channel,
					limit: fetchLimit,
				});
				let extra = r.messages ?? [];
				if (exclude) {
					extra = extra.filter((m) => !m.thread_ts || m.thread_ts === m.ts);
				}
				msgs = extra.slice(0, limit);
			}

			// Enrich with user names
			const enriched = await Promise.all(
				msgs.map(async (m) => {
					if (m.user && !m.bot_id) {
						const cached = userCache.get(m.user);
						if (cached) {
							return {
								...m,
								user_name: cached.real_name ?? cached.profile?.real_name ?? m.user,
							};
						}
						try {
							const info = await slack.users.info({ user: m.user });
							if (info.user) userCache.set(m.user, info.user);
							return {
								...m,
								user_name:
									info.user?.real_name ??
									info.user?.profile?.real_name ??
									info.user?.name ??
									m.user,
							};
						} catch {
							return { ...m, user_name: m.user };
						}
					}
					return m;
				}),
			);

			const out = fmt === "compact" ? enriched.map(compactMessage) : enriched;
			return JSON.stringify(out, null, 2);
		},
	},
	{
		name: "get_user_info",
		description: "Look up a Slack user. Returns compact profile by default.",
		inputSchema: {
			type: "object",
			properties: {
				user: { type: "string", description: "User ID (e.g. U3QP6CC3V)." },
				format: { type: "string", enum: ["compact", "full"] },
			},
			required: ["user"],
		},
		handler: async (_session, args) => {
			const cached = userCache.get(args.user);
			let user = cached;
			if (!user) {
				const info = await slack.users.info({ user: args.user });
				if (info.user) {
					user = info.user;
					userCache.set(args.user, user);
				}
			}
			if (!user) throw new Error(`user not found: ${args.user}`);
			const fmt = args.format ?? "compact";
			return JSON.stringify(fmt === "compact" ? compactUser(user) : user, null, 2);
		},
	},
	{
		name: "list_channels",
		description: "List channels the bot can access. Returns compact format by default.",
		inputSchema: {
			type: "object",
			properties: {
				types: {
					type: "string",
					description: "Comma-separated: public_channel,private_channel,mpim,im",
				},
				include_archived: { type: "boolean" },
				format: { type: "string", enum: ["compact", "full"] },
			},
		},
		handler: async (_session, args) => {
			const types = args.types ?? "public_channel,private_channel";
			const r = await slack.conversations.list({ types });
			let channels = r.channels ?? [];
			if (!args.include_archived) channels = channels.filter((c) => !c.is_archived);
			for (const c of channels) {
				if (c.id) channelCache.set(c.id, c);
			}
			const fmt = args.format ?? "compact";
			return JSON.stringify(fmt === "compact" ? channels.map(compactChannel) : channels, null, 2);
		},
	},
	{
		name: "list_users",
		description: "List users in the workspace. Returns compact format by default.",
		inputSchema: {
			type: "object",
			properties: {
				include_bots: { type: "boolean" },
				include_deleted: { type: "boolean" },
				format: { type: "string", enum: ["compact", "full"] },
			},
		},
		handler: async (_session, args) => {
			const r = await slack.users.list({});
			let users = r.members ?? [];
			if (!args.include_deleted) users = users.filter((u) => !u.deleted);
			if (!args.include_bots) users = users.filter((u) => !u.is_bot && u.id !== "USLACKBOT");
			for (const u of users) {
				if (u.id) userCache.set(u.id, u);
			}
			const fmt = args.format ?? "compact";
			return JSON.stringify(fmt === "compact" ? users.map(compactUser) : users, null, 2);
		},
	},
];

// ─── Per-session MCP server factory ───────────────────────────────────────────

function buildSessionServer(): {
	transport: WebStandardStreamableHTTPServerTransport;
	server: Server;
	getSessionId: () => string;
} {
	let assignedId = "";
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: (sid) => {
			assignedId = sid;
			log(`session initialized: ${sid}`);
			const session: Session = {
				id: sid,
				server,
				transport,
				threads: new Set(),
				channels: new Set(),
			};
			sessions.set(sid, session);
		},
		onsessionclosed: (sid) => {
			const s = sessions.get(sid);
			if (s) {
				log(
					`session closed: ${sid}, dropping ${s.threads.size} thread + ${s.channels.size} channel sub(s)`,
				);
				sessions.delete(sid);
			}
		},
	});

	const server = new Server(
		{ name: `slack-bus-${INSTANCE}`, version: "0.3.0" },
		{
			capabilities: {
				experimental: { "claude/channel": {} },
				tools: {},
			},
			instructions: [
				`This MCP server is the slack-bus for instance "${INSTANCE}". It exposes Slack actions (post/update/delete/react, lookups, file ops, streaming) plus session-scoped subscriptions for inbound Slack events.`,
				"When you post a top-level message, the bus auto-subscribes this session to replies AND to reactions on that message. Inbound events arrive as `notifications/claude/channel` system reminders. kinds: `thread_reply` (someone replied), `channel_message` (new message in a subscribed channel), `reaction` / `reaction_removed` (someone reacted to a subscribed message or to anything in a subscribed channel).",
				"For channel-wide subscriptions, call `subscribe_channel`. For specific existing threads you didn't post, `subscribe_thread`.",
				"Slack mrkdwn syntax: *bold*, _italic_, ~strike~, <url|text>, <@USERID>. No standard markdown.",
				"For rich layouts, post Block Kit `blocks` and a short `text` fallback.",
			].join(" "),
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOLS.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const tool = TOOLS.find((t) => t.name === req.params.name);
		if (!tool) {
			throw new Error(`unknown tool: ${req.params.name}`);
		}
		const session = sessions.get(assignedId);
		if (!session) {
			// Tool called before onsessioninitialized fired. Unlikely with stateful
			// transport (initialize always precedes call), but handle defensively.
			throw new Error("session not initialized");
		}
		try {
			const text = await tool.handler(session, (req.params.arguments ?? {}) as any);
			return { content: [{ type: "text", text }] };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`tool ${tool.name} error in session ${session.id}: ${msg}`);
			return {
				content: [{ type: "text", text: `Error: ${msg}` }],
				isError: true,
			};
		}
	});

	void server.connect(transport);

	return {
		transport,
		server,
		getSessionId: () => assignedId,
	};
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	// SSE streams from MCP Streamable HTTP must stay open indefinitely so the
	// server can push notifications. Bun's default 10s idleTimeout would kill
	// them — and we'd never push events to a live session.
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname !== "/mcp") {
			return new Response("not found", { status: 404 });
		}

		const sessionId = req.headers.get("mcp-session-id") ?? undefined;

		// Existing session: route to its transport.
		if (sessionId && sessions.has(sessionId)) {
			log(`req method=${req.method} session=${sessionId.slice(0, 8)}…`);
			return sessions.get(sessionId)!.transport.handleRequest(req);
		}

		// New session: only valid on POST (initialize). Build a transport+server pair.
		if (req.method !== "POST") {
			return new Response("missing or unknown mcp-session-id", { status: 400 });
		}

		log(`new connection from ${req.headers.get("user-agent") ?? "?"}`);
		const { transport } = buildSessionServer();
		return transport.handleRequest(req);
	},
});

// ─── Start ────────────────────────────────────────────────────────────────────

await slackApp.start();
const myId = await getBotUserId();
log(`Slack Socket Mode connected. bot_user_id=${myId}`);
log(`listening on http://localhost:${PORT}/mcp`);

function shutdown(sig: string) {
	log(`received ${sig}, shutting down`);
	process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
