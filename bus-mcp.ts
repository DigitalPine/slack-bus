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
import { classifyError } from "./classify-error.ts";
import { renderTimestamp } from "./format-time.ts";
import {
	formatIdle,
	hasActiveSub,
	isIdleExpired,
	pruneExpiredSubs,
	threadKey,
	ttlToExpiresAt,
} from "./lifecycle.ts";
import {
	applyEntityResolution,
	type EntityMaps,
	extractEntityIds,
} from "./resolve-entities.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

const VERSION = "0.8.1";

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

const BOOT_TIME_MS = Date.now();

// Verbose inbound tracing. OFF by default because slackApp.message fires for
// EVERY message in EVERY channel the bot is in — logging each arrival/drop
// unconditionally would flood the log. Flip SLACK_BUS_DEBUG=1 (and restart)
// when diagnosing "I'm not getting notifications": it makes every inbound
// event's outcome visible (matched N sessions / 0 sessions / dropped + why),
// so a single log read localizes the failure (never-arrived vs no-matching-sub
// vs dead-push-stream). See DIG-280.
const DEBUG = /^(1|true|yes)$/i.test(process.env.SLACK_BUS_DEBUG ?? "");

const LOG_FILE = `/tmp/slack-bus-${INSTANCE}.log`;

function log(msg: string) {
	const line = `[${new Date().toISOString()}] [bus:${INSTANCE}] ${msg}\n`;
	try {
		appendFileSync(LOG_FILE, line);
	} catch {}
	process.stdout.write(line);
}

// logError prefixes the message with `ERROR ` so log triage is a single grep
// away. Use for anything an operator should notice — tool failures, Slack API
// errors, process-level unhandled events.
function logError(msg: string) {
	log(`ERROR ${msg}`);
}

// debug logs are gated by SLACK_BUS_DEBUG (see DEBUG above). Prefixed `DEBUG `
// so they're a single grep to include or exclude. Use for high-volume inbound
// tracing that would otherwise flood the log on a busy workspace.
function debug(msg: string) {
	if (DEBUG) log(`DEBUG ${msg}`);
}

// Channel-notification `meta` MUST be Record<string,string>. Claude Code validates
// it with Zod and throws an "expected string, received <type>" error INSIDE its
// notification handler on any non-string value — silently dropping the event before
// it renders (the daemon still logs the send as OK). Coerce every value to a string
// and drop null/undefined so a future non-string field can never break delivery.
function coerceMeta(meta: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(meta)) {
		if (v === undefined || v === null) {
			// A dropped key usually means an upstream lookup failed (e.g.
			// getUserName/getChannelName returned undefined). Coercion keeps the
			// event deliverable, but the missing field is worth a breadcrumb.
			debug(`coerceMeta dropped null/undefined meta key: ${k}`);
			continue;
		}
		out[k] = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
	}
	return out;
}

// Truncate-but-readable serialization for arg dicts in error logs. Tool args
// may contain Block Kit blocks or long text; we don't want a single error
// line to be 4KB. 240 chars is enough to see channel/ts/key fields.
function inspectArgs(args: unknown): string {
	try {
		const json = JSON.stringify(args);
		if (!json) return "(none)";
		return json.length > 240 ? `${json.slice(0, 237)}...` : json;
	} catch {
		return "(unserializable)";
	}
}

// ─── Process-level safety net ─────────────────────────────────────────────────
// Without these, an uncaughtException or unhandledRejection inside a tool
// handler, the slackApp event loop, or any setImmediate would either kill the
// process silently (Node default in older versions) or spew to stderr where
// nothing collects it. Funnel everything into our log file so a post-mortem
// is one `grep ERROR` away.

process.on("uncaughtException", (err) => {
	logError(`uncaughtException: ${err?.stack ?? err}`);
});
process.on("unhandledRejection", (reason) => {
	const msg =
		reason instanceof Error
			? (reason.stack ?? reason.message)
			: typeof reason === "object"
				? JSON.stringify(reason)
				: String(reason);
	logError(`unhandledRejection: ${msg}`);
});

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
		// Absolute rendering of `ts` so the agent never converts epoch→date in
		// its head. `ts` stays authoritative for API calls (thread_ts etc.).
		when: msg.ts ? renderTimestamp(msg.ts) : undefined,
		text: msg.text ?? "",
		type: msg.type ?? "message",
	};
	// When the daemon has resolved entity tokens into human-legible text, the
	// caller stashed the original on msg.text_raw — preserve it so the agent
	// still has the bracket-escaped form for fidelity / re-emit if it needs to.
	if (msg.text_raw && msg.text_raw !== out.text) out.text_raw = msg.text_raw;
	if (msg.user) out.user = msg.user;
	if (msg.bot_id) out.bot_id = msg.bot_id;
	if (msg.user_name) out.user_name = msg.user_name;
	if (msg.thread_ts) out.thread_ts = msg.thread_ts;
	if (Array.isArray(msg.reactions)) {
		// reactor_names (when present) is a per-reaction array of resolved display
		// names — see the get_channel_context enrichment pass. Surface it so the
		// agent can answer "who reacted with :tada:?" without a second lookup;
		// when unavailable (notification paths skip the resolve), we silently
		// fall back to just name+count.
		out.reactions = msg.reactions.map((r: any) => ({
			name: r.name,
			count: r.count ?? (r.users?.length ?? 0),
			...(Array.isArray(r.reactor_names) && r.reactor_names.length > 0
				? { users: r.reactor_names }
				: {}),
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

// Catch errors that escape individual event handlers. Without this, Bolt
// errors land in its own logger and bypass our log file entirely.
slackApp.error(async (err) => {
	logError(`slackApp.error: ${err?.stack ?? err}`);
});

// ─── Slack connectivity tracking ──────────────────────────────────────────────
// Mirror the Socket Mode connection state so bus_status (and an operator
// grepping the log) can tell whether the daemon's INBOUND link to Slack is up.
//
// Scope caveat: this is the daemon→Slack inbound websocket only — it carries
// replies/reactions. OUTBOUND posting (chat.postMessage) goes over the Web API
// independently and is NOT represented here; a post can succeed while the
// socket is mid-reconnect, and vice versa. Outbound failures surface per-call
// via classifyError(). And neither leg is the client→daemon MCP transport,
// whose failure shows up client-side as an "unhealthy" server, never here.
//
// Socket Mode rotates connections routinely (Slack recycles the websocket every
// so often), so a `disconnected`/`reconnecting` cycle is normal churn, not an
// outage. We log it at info level and never raise ERROR for it — a real outage
// shows up as the state sticking off "connected" with a growing
// seconds_since_last_event in bus_status.

const socketHealth = {
	state: "starting", // last Socket Mode state seen
	connected: false,
	lastEventAt: Date.now(),
	lastConnectedAt: null as number | null,
	lastDisconnectedAt: null as number | null,
	connectCount: 0,
	disconnectCount: 0,
};

function attachSocketHealthListeners() {
	// Bolt's SocketModeReceiver holds the SocketModeClient (an EventEmitter) at
	// `.client`. Duck-typed so a Bolt internals shuffle degrades gracefully
	// rather than crashing the daemon.
	const socketClient = (slackApp as any).receiver?.client;
	if (!socketClient || typeof socketClient.on !== "function") {
		logError(
			"socket health: receiver.client not an EventEmitter — bus_status slack.* will report best-effort 'starting' state",
		);
		return;
	}
	socketClient.on("connecting", () => {
		socketHealth.state = "connecting";
		socketHealth.lastEventAt = Date.now();
	});
	socketClient.on("authenticated", () => {
		socketHealth.state = "authenticated";
		socketHealth.lastEventAt = Date.now();
	});
	socketClient.on("connected", () => {
		socketHealth.state = "connected";
		socketHealth.connected = true;
		socketHealth.lastConnectedAt = Date.now();
		socketHealth.lastEventAt = Date.now();
		socketHealth.connectCount += 1;
		// First connect is logged by the boot sequence; only announce reconnects.
		if (socketHealth.connectCount > 1) {
			log(`Socket Mode reconnected (connect #${socketHealth.connectCount})`);
		}
	});
	socketClient.on("reconnecting", () => {
		socketHealth.state = "reconnecting";
		socketHealth.connected = false;
		socketHealth.lastEventAt = Date.now();
		log("Socket Mode reconnecting");
	});
	socketClient.on("disconnecting", () => {
		socketHealth.state = "disconnecting";
		socketHealth.connected = false;
		socketHealth.lastEventAt = Date.now();
	});
	socketClient.on("disconnected", () => {
		socketHealth.state = "disconnected";
		socketHealth.connected = false;
		socketHealth.lastDisconnectedAt = Date.now();
		socketHealth.lastEventAt = Date.now();
		socketHealth.disconnectCount += 1;
		log("Socket Mode disconnected");
	});
}
attachSocketHealthListeners();

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
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// channel_not_found is the boring case (bot doesn't have access). Log
		// anything else so we notice when Slack lookups break in production.
		if (!msg.includes("channel_not_found")) {
			logError(`getChannelName(${channelId}) failed: ${msg}`);
		}
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
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("user_not_found")) {
			logError(`getUserName(${userId}) failed: ${msg}`);
		}
		return userId;
	}
}

// Bulk-resolve the user/channel ids extracted from one or more message bodies,
// using the existing userCache/channelCache as the primary store. Cache hits
// are free; cache misses run as one parallel batch. Lookup failures fall back
// to the bare id (handled inside getUserName/getChannelName), which
// applyEntityResolution then renders as `@U0123` / `#C0456`.
//
// This is the only async glue between `extractEntityIds` and
// `applyEntityResolution`; keeping the resolution itself pure makes the
// substitution rules unit-testable without faking the Slack web API.
async function buildEntityMaps(texts: Array<string | undefined>): Promise<EntityMaps> {
	const allUserIds = new Set<string>();
	const allChannelIds = new Set<string>();
	for (const t of texts) {
		if (!t) continue;
		const { userIds, channelIds } = extractEntityIds(t);
		for (const id of userIds) allUserIds.add(id);
		for (const id of channelIds) allChannelIds.add(id);
	}
	const users = new Map<string, string>();
	const channels = new Map<string, string>();
	await Promise.all([
		...[...allUserIds].map(async (id) => {
			users.set(id, await getUserName(id));
		}),
		...[...allChannelIds].map(async (id) => {
			channels.set(id, await getChannelName(id));
		}),
	]);
	return { users, channels };
}

// ─── Sessions & routing ───────────────────────────────────────────────────────

type Session = {
	id: string;
	server: Server;
	transport: WebStandardStreamableHTTPServerTransport;
	// Value is expiresAt (epoch ms) for TTL'd subs, or null for session-lifetime.
	threads: Map<string, number | null>; // "channel:thread_ts" → expiresAt|null
	channels: Map<string, number | null>; // "channel" → expiresAt|null
	// Bumped on every HTTP request routed to this session. The idle reaper
	// uses it to drop sessions the client has abandoned without sending DELETE
	// (which is what real MCP clients like Claude Code do today — see DIG-203).
	lastSeen: number;
};

const sessions = new Map<string, Session>();

// ─── Subscription retention for GET-stream re-adoption (DIG-279) ───────────────
// When a session is dropped (idle-reaped, or a clean DELETE) its subscription set
// is preserved here, keyed by sid, for a bounded window — so that if the same
// client reconnects carrying the old sid (a GET event-stream re-adoption; see the
// fetch handler), we can rehydrate its subscriptions onto the re-adopted session.
//
// Why this is slack-bus-specific: channels-lab proved (FINDINGS.md, real
// claude-code@2.1.165, n=2, 200-vs-404 causal) that answering the unknown-sid GET
// reconnect with 200 + a fresh live stream restores RENDER. But slack-bus event
// routing is *subscription-gated* — a re-adopted session with empty subs renders a
// live pipe yet routes ZERO Slack events. So re-adoption MUST also restore subs.
// (runtime-bus/probe-bus aren't sub-gated, so their probe never surfaced this.)
//
// NOTE: this map is in-memory, so it survives the forget-without-restart window
// (reaper / DELETE) but NOT a daemon process restart. Cross-restart rehydration
// needs disk persistence — gated on confirming restart-parity (does a real client
// reconnect with its old sid after an actual process restart?). See DIG-279.
type RetainedSubs = {
	threads: Map<string, number | null>;
	channels: Map<string, number | null>;
	retainedAt: number;
};
const retainedSubs = new Map<string, RetainedSubs>();
// Retained subs older than this are swept — a re-adoption reconnect lands ~1s
// after the drop, so an hour is generous insurance, not a tuned value.
const RETAINED_SUBS_TTL_MS = (() => {
	const fromEnv = Number(process.env.SLACK_BUS_RETAINED_SUBS_TTL_SECONDS);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv * 1000);
	return 60 * 60 * 1000;
})();

// Preserve a dropped session's subs for possible re-adoption. No-op when the
// session held no subscriptions (nothing to rehydrate — re-adoption would build a
// fresh empty session anyway).
function retainSubs(s: Session): void {
	if (s.threads.size === 0 && s.channels.size === 0) return;
	retainedSubs.set(s.id, {
		threads: new Map(s.threads),
		channels: new Map(s.channels),
		retainedAt: Date.now(),
	});
}

// Reclaim (and remove) retained subs for a re-adopted sid, if still within TTL.
function takeRetainedSubs(sid: string): RetainedSubs | undefined {
	const r = retainedSubs.get(sid);
	if (!r) return undefined;
	retainedSubs.delete(sid);
	if (Date.now() - r.retainedAt > RETAINED_SUBS_TTL_MS) return undefined;
	return r;
}

// Pure lifecycle helpers (TTL expiry + idle reaping) live in lifecycle.ts so
// they're unit-testable without booting the daemon. See tests/lifecycle.test.ts.

// ─── Subscription / session lifecycle reaper ──────────────────────────────────
// Sweeps every minute: drops individually-expired subs from each session, then
// reaps sessions that have been idle longer than IDLE_REAP_MS (the client is
// almost certainly dead — Claude Code doesn't send MCP DELETE on exit, so the
// transport's onsessionclosed never fires). 24h is loose by design; tighten
// once we have observability on false-reap rate.

const IDLE_REAP_MS = (() => {
	const fromEnv = Number(process.env.SLACK_BUS_IDLE_REAP_SECONDS);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv * 1000);
	return 24 * 60 * 60 * 1000;
})();
const REAPER_INTERVAL_MS = (() => {
	const fromEnv = Number(process.env.SLACK_BUS_REAPER_INTERVAL_SECONDS);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv * 1000);
	return 60 * 1000;
})();

// Slack inbound event router. Same logic as the unix-socket bus, but pushes
// via the per-session MCP transport instead of a socket frame.
slackApp.message(async ({ message }) => {
	// Bolt's `message` event is a union over many subtypes; we only route
	// plain user messages. The `subtype === undefined` discriminator narrows
	// to GenericMessageEvent, which carries channel/user/ts/thread_ts cleanly.
	// Slack `message` events with a subtype are edits, joins, file_share,
	// thread_broadcast, bot_message, etc. We only route plain user messages.
	// These drops are silent by design but high-volume — trace under DEBUG.
	if (message.subtype !== undefined) {
		debug(`inbound message dropped (subtype=${message.subtype}) in ${(message as { channel?: string }).channel ?? "?"}`);
		return;
	}
	const m = message as GenericMessageEvent;
	if (!m.text || !m.user) {
		// e.g. blocks-only message with no top-level text.
		debug(`inbound message dropped (no text/user) in ${m.channel}`);
		return;
	}

	const myId = await getBotUserId();
	if (m.user === myId) {
		debug(`inbound message dropped (bot self-post) in ${m.channel}`);
		return;
	}

	const channelId = m.channel;
	const threadTs = m.thread_ts;
	const isReply = !!threadTs;
	const tKey = isReply ? threadKey(channelId, threadTs) : null;

	const matches: Array<{ session: Session; kind: "thread_reply" | "channel_message" }> = [];
	for (const session of sessions.values()) {
		if (tKey && hasActiveSub(session.threads, tKey)) {
			matches.push({ session, kind: "thread_reply" });
		} else if (hasActiveSub(session.channels, channelId)) {
			matches.push({ session, kind: "channel_message" });
		}
	}
	if (matches.length === 0) {
		// Arrived but matched no subscription. The single most useful diagnostic
		// when "I'm not getting notifications": this line present = Slack DID
		// deliver, so the gap is a missing/expired sub, not the inbound socket.
		// channelId (not name) to avoid a Web API call on every ignored message.
		debug(`inbound ${isReply ? "reply" : "message"} in ${channelId}${threadTs ? "/" + threadTs : ""} → 0 sessions (no matching sub)`);
		return;
	}

	const [userName, channelName, entityMaps] = await Promise.all([
		getUserName(m.user),
		getChannelName(channelId),
		buildEntityMaps([m.text]),
	]);

	const rawText = typeof m.text === "string" ? m.text : "";
	const resolvedText = rawText ? applyEntityResolution(rawText, entityMaps) : rawText;

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
			when: renderTimestamp(m.ts),
			user_id: m.user,
			user_name: userName,
		};
		if (threadTs) meta.thread_ts = threadTs;
		// If entity resolution changed the body, surface the original alongside
		// so the agent can still see raw `<@U…>` / `<#C…>` if it ever needs to.
		if (resolvedText !== rawText) meta.text_raw = rawText;

		session.server
			.notification({
				method: "notifications/claude/channel",
				params: {
					content: resolvedText,
					meta: coerceMeta(meta),
				},
			})
			.then(() =>
				// NOT delivery confirmation: the SDK's send() resolves even when it
				// writes into a stale/half-open standalone SSE controller (no liveness
				// check), so a resolved promise means "enqueued server-side," never
				// "rendered by the client." The old "dispatched OK" wording masked the
				// DIG-279 zombie for months. Say only what we know. Mirrors peer-bus.
				log(`notification → ${session.id} sent (send-side only, not delivery-confirmed; kind=${kind})`),
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
	if (event.item.type !== "message") {
		debug(`${kind} dropped (item.type=${event.item.type}, not a message)`);
		return;
	}
	const myId = await getBotUserId();
	if (event.user === myId) {
		debug(`${kind} :${event.reaction}: dropped (bot self-reaction)`);
		return;
	}

	const channelId = event.item.channel;
	const itemTs = event.item.ts;
	const tKey = threadKey(channelId, itemTs);

	const matches: Session[] = [];
	for (const session of sessions.values()) {
		if (hasActiveSub(session.threads, tKey) || hasActiveSub(session.channels, channelId)) {
			matches.push(session);
		}
	}
	if (matches.length === 0) {
		// Arrived but matched no sub. Note: a reaction on a *reply inside* a
		// subscribed thread lands here too — routing keys on the item's own ts,
		// not the thread parent (documented limitation above).
		debug(`${kind} :${event.reaction}: on ${channelId}/${itemTs} → 0 sessions (no matching sub)`);
		return;
	}

	const [userName, channelName, itemUserName] = await Promise.all([
		getUserName(event.user),
		getChannelName(channelId),
		event.item_user ? getUserName(event.item_user) : Promise.resolve(undefined),
	]);

	log(
		`${kind} :${event.reaction}: in ${channelName}/${itemTs} by ${userName} → ${matches.length} session(s)`,
	);

	const verb = kind === "reaction" ? "added" : "removed";
	for (const session of matches) {
		// Surface the *target* message's author in the content string so the
		// agent doesn't have to cross-reference item_user vs the reactor — both
		// the doer and the recipient are named in one line.
		const onWhose = itemUserName ? ` (${itemUserName}'s message)` : "";
		session.server
			.notification({
				method: "notifications/claude/channel",
				params: {
					content: `Reaction :${event.reaction}: ${verb} by ${userName} at ${renderTimestamp(event.event_ts)} on message ts=${itemTs}${onWhose} in ${channelName}.`,
					meta: coerceMeta({
						source: "slack-bus",
						kind,
						channel_id: channelId,
						channel_name: channelName,
						reaction: event.reaction,
						item_ts: itemTs,
						item_when: renderTimestamp(itemTs),
						item_user: event.item_user,
						item_user_name: itemUserName,
						ts: event.event_ts,
						when: renderTimestamp(event.event_ts),
						user_id: event.user,
						user_name: userName,
					}),
				},
			})
			.then(() =>
				// NOT delivery confirmation: the SDK's send() resolves even when it
				// writes into a stale/half-open standalone SSE controller (no liveness
				// check), so a resolved promise means "enqueued server-side," never
				// "rendered by the client." The old "dispatched OK" wording masked the
				// DIG-279 zombie for months. Say only what we know. Mirrors peer-bus.
				log(`notification → ${session.id} sent (send-side only, not delivery-confirmed; kind=${kind})`),
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

// Slack's canvas methods take JSON bodies with nested document_content / changes
// arrays — the typed WebClient form-encodes args, which mangles that shape. We
// call them directly (Bearer + JSON, matching Slack's spec) and reshape any
// failure into a WebAPICallError-like error ({ data: { error } }) so the shared
// classifyError() buckets it — notably the free-tier canvas restriction, which
// we want surfaced as an actionable "use a channel canvas instead" message
// rather than an opaque code.
async function canvasApi(
	method: string,
	body: Record<string, unknown>,
): Promise<any> {
	const res = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as {
		ok: boolean;
		error?: string;
		detail?: string;
		[k: string]: unknown;
	};
	if (!json.ok) {
		const detail = json.detail ? ` (${json.detail})` : "";
		const err = new Error(
			`Slack ${method} failed: ${json.error ?? "unknown_error"}${detail}`,
		) as Error & { data?: { error?: string } };
		// Shape like @slack/web-api's WebAPICallError so classifyError sees the code.
		err.data = { error: json.error };
		throw err;
	}
	return json;
}

const TOOLS: Tool[] = [
	// ─── Messaging ────────────────────────────────────────────────────────────
	{
		name: "post_message",
		description:
			"Post a message to a Slack channel or thread. Accepts Block Kit blocks for rich content; pass `text` as a notification fallback. When posting top-level (no thread_ts), this session is auto-subscribed to BOTH replies in the resulting thread AND reactions on the posted message — they'll arrive as `notifications/claude/channel` system reminders (kinds `thread_reply`, `reaction`, `reaction_removed`). The auto-subscription lives for the session unless you bound it with `ttl_seconds`.",
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
				ttl_seconds: {
					type: "number",
					description:
						"Bound the auto-subscription's lifetime to this many seconds. Omit (or pass <=0) for session-lifetime. Has no effect when auto_subscribe is false or thread_ts is set.",
				},
			},
			required: ["channel"],
		},
		handler: async (session, args) => {
			const { channel, blocks, text, thread_ts, unfurl_links, unfurl_media } = args;
			const auto = args.auto_subscribe !== false;
			const expiresAt = ttlToExpiresAt(args.ttl_seconds);

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
				session.threads.set(threadKey(channel, ts), expiresAt);
				const ttlNote = expiresAt === null ? "" : ` (expires in ${Math.round((expiresAt - Date.now()) / 1000)}s)`;
				note += `. Auto-subscribed to replies in this thread${ttlNote}.`;
				log(`session ${session.id} posted to ${channel}, auto-subscribed to thread ${ts}${expiresAt === null ? "" : ` ttl=${args.ttl_seconds}s`}`);
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
			"Subscribe this session to ALL new messages in a channel. Each new message arrives as a `notifications/claude/channel` system reminder with kind=channel_message. Defaults to session-lifetime; pass `ttl_seconds` to bound the window.",
		inputSchema: {
			type: "object",
			properties: {
				channel_id: { type: "string", description: "Channel ID to subscribe to." },
				ttl_seconds: {
					type: "number",
					description:
						"How long the subscription stays active (seconds). Omit (or pass <=0) for session-lifetime. Useful when you only need to watch a channel for a bounded window — the bus drops the sub automatically when it expires, no unsubscribe call needed.",
				},
			},
			required: ["channel_id"],
		},
		handler: async (session, args) => {
			const expiresAt = ttlToExpiresAt(args.ttl_seconds);
			session.channels.set(args.channel_id, expiresAt);
			const ttlNote = expiresAt === null ? "for the lifetime of this session" : `for ${Math.round((expiresAt - Date.now()) / 1000)}s`;
			log(`session ${session.id} subscribed to channel ${args.channel_id} ${ttlNote} (now ${session.channels.size})`);
			return `Subscribed to channel ${args.channel_id} ${ttlNote}.`;
		},
	},
	{
		name: "subscribe_thread",
		description:
			"Subscribe this session to replies in a specific thread. Use when you want to follow a thread you didn't post yourself. Replies arrive as `notifications/claude/channel` reminders with kind=thread_reply. Defaults to session-lifetime; pass `ttl_seconds` to bound the window.",
		inputSchema: {
			type: "object",
			properties: {
				channel_id: { type: "string", description: "Channel ID." },
				thread_ts: { type: "string", description: "Thread parent message ts." },
				ttl_seconds: {
					type: "number",
					description:
						"How long the subscription stays active (seconds). Omit (or pass <=0) for session-lifetime. The bus drops the sub automatically when it expires.",
				},
			},
			required: ["channel_id", "thread_ts"],
		},
		handler: async (session, args) => {
			const expiresAt = ttlToExpiresAt(args.ttl_seconds);
			session.threads.set(threadKey(args.channel_id, args.thread_ts), expiresAt);
			const ttlNote = expiresAt === null ? "for the lifetime of this session" : `for ${Math.round((expiresAt - Date.now()) / 1000)}s`;
			log(
				`session ${session.id} subscribed to thread ${args.channel_id}/${args.thread_ts} ${ttlNote} (now ${session.threads.size})`,
			);
			return `Subscribed to thread ${args.channel_id}/${args.thread_ts} ${ttlNote}.`;
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
		name: "upload_file",
		description:
			"Upload a file from disk to Slack. Any file type Slack accepts — images (PNG, JPEG, GIF), video (MP4, MOV), audio, PDF, archives, etc. With `channel`, posts it (Slack renders most types inline — videos play, images preview, PDFs get a viewer). Without `channel`, just uploads and returns the file ID. For images specifically, the file ID can be embedded via a Block Kit `image` block (returned in the response).",
		inputSchema: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Absolute path to the file.",
				},
				channel: {
					type: "string",
					description: "Channel ID to post to (optional). Omit to just upload.",
				},
				initial_comment: {
					type: "string",
					description: "Comment posted alongside the file.",
				},
				thread_ts: {
					type: "string",
					description: "Thread ts (requires channel).",
				},
				title: { type: "string", description: "Title shown on the file in Slack." },
				alt_text: {
					type: "string",
					description: "Alt text for accessibility. Mainly meaningful for images.",
				},
			},
			required: ["file_path"],
		},
		handler: async (_session, args) => {
			if (args.thread_ts && !args.channel) {
				throw new Error("thread_ts requires channel to be specified");
			}
			const fileBuffer = await readFile(args.file_path);
			const filename = String(args.file_path).split("/").pop() || "file";
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

			// Only emit the Block Kit image-block hint for image files —
			// Slack auto-renders video/audio/pdf inline without any block.
			const ext = filename.split(".").pop()?.toLowerCase() ?? "";
			const isImage = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);

			let response = `File uploaded. file_id=${fileId} filename=${filename}`;
			if (args.channel) {
				response += `\nPosted to ${args.channel}${args.thread_ts ? ` (in thread)` : ""}. Slack will render it inline.`;
			} else if (isImage) {
				response += `\n\nTo embed in a message, use this image block:\n${JSON.stringify(
					{
						type: "image",
						slack_file: { id: fileId },
						alt_text: args.alt_text || filename,
					},
					null,
					2,
				)}`;
			} else {
				response += `\n\nTo share the file in a channel, call post_message with the file_id referenced in your text, or re-call upload_file with a channel argument.`;
			}
			return response;
		},
	},
	{
		name: "get_file_from_slack",
		description:
			"Download any Slack-uploaded file by file ID — image, video, audio, PDF, snippet, etc. Returns the local file path under /tmp. The extension matches the original file's type.",
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
			// Prefer file.filetype, then derive from file.name's extension
			// (Slack sometimes returns empty filetype/mimetype for very recent
			// uploads even when file.name is set), final fallback "bin".
			const ext =
				file.filetype || file.name?.split(".").pop()?.toLowerCase() || "bin";
			const localPath = `/tmp/slack-file-${timestamp}.${ext}`;

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
			return `File downloaded to: ${localPath}\nName: ${file.name}\nType: ${file.mimetype}\nSize: ${file.size} bytes`;
		},
	},
	{
		name: "upload_text",
		description:
			"Upload text content (held in memory) to Slack as a file. Distinct from `upload_file` which reads from disk. Use for code snippets, logs, JSON dumps, anything you want to share as an attached file without first writing to disk. Up to ~1MB. Renders in Slack with syntax highlighting based on the filename extension.",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID." },
				content: { type: "string", description: "Text content to upload." },
				filename: {
					type: "string",
					description:
						"Filename including extension (e.g. 'code.js', 'log.txt'). Slack uses the extension for syntax highlighting.",
				},
				title: { type: "string", description: "Title (default: filename)." },
				thread_ts: { type: "string", description: "Thread ts." },
			},
			required: ["channel", "content", "filename"],
		},
		handler: async (_session, args) => {
			const title = args.title || args.filename;
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
				files: [{ id: urlRes.file_id, title }],
				channel_id: args.channel,
				thread_ts: args.thread_ts,
			});
			return `Text uploaded as ${args.filename} (${contentLength} bytes)`;
		},
	},

	// ─── Canvases ─────────────────────────────────────────────────────────────
	// A canvas is a Slack-native rich document. Content is Slack-flavored
	// markdown (NOT Block Kit, NOT mrkdwn): # ## ### headings, **bold**, _italic_,
	// ~~strike~~, `code`, ```fences```, - bullets, 1. ordered, - [ ] / - [x]
	// checkboxes (done items render struck-through), > quotes, --- dividers,
	// [text](url) links, ![alt](url) images, and | tables | (max 300 cells).
	// Images render INLINE only if Slack can fetch the URL publicly — for
	// private/local images, upload_file first and embed the returned permalink.
	// No cover images via API (UI-only). On a FREE workspace, standalone
	// (non-tabbed) canvases can't be created — attach to a channel instead.
	{
		name: "create_canvas",
		description:
			"Create a Slack canvas — a rich Slack-native document (headings, checklists, tables, quotes, inline images, links). Body is Slack-flavored markdown (see `markdown`).\n\n" +
			"• WITHOUT `channel_id`: a standalone canvas (lives in Files, shareable by URL). PAID workspaces only — on a free workspace this fails with `free_teams_cannot_create_non_tabbed_canvases`; pass `channel_id` or use create_channel_canvas instead.\n" +
			"• WITH `channel_id`: also attaches the canvas as a tab on that channel (bot must be a member). Works on free workspaces.\n\n" +
			"Returns canvas_id. Mutate later with edit_canvas; get section ids for targeted edits with lookup_canvas_sections.",
		inputSchema: {
			type: "object",
			properties: {
				markdown: {
					type: "string",
					description:
						"Canvas body, Slack-flavored markdown. Supported: # ## ### headings, **bold**, _italic_, ~~strike~~, `code`, fenced code, - bullets, 1. ordered lists, - [ ] / - [x] checkboxes (done → struck-through), > quote blocks, --- dividers, [text](url) links, ![alt](url) images (inline ONLY if Slack can publicly fetch the URL — else upload_file and embed the permalink), and | markdown tables | (max 300 cells total). NOT supported: Block Kit, cover images (UI-only), deeply nested lists.",
				},
				title: {
					type: "string",
					description: "Canvas title shown at the top and in the file list.",
				},
				channel_id: {
					type: "string",
					description:
						"Optional. Attach the canvas as a tab on this channel (bot must be a member). REQUIRED on free workspaces — a standalone canvas (no channel_id) is paid-only.",
				},
			},
			required: ["markdown"],
		},
		handler: async (_session, args) => {
			const body: Record<string, unknown> = {
				document_content: { type: "markdown", markdown: args.markdown },
			};
			if (args.title) body.title = args.title;
			if (args.channel_id) body.channel_id = args.channel_id;
			const res = await canvasApi("canvases.create", body);
			const where = args.channel_id
				? ` as a tab on ${args.channel_id}`
				: " (standalone)";
			return `Canvas created${where}. canvas_id=${res.canvas_id}\nEdit with edit_canvas; list section ids with lookup_canvas_sections.`;
		},
	},
	{
		name: "create_channel_canvas",
		description:
			"Create/set the canvas built into a channel (its Canvas tab) via conversations.canvases.create. Distinct from create_canvas with a channel_id: this is THE channel's own canvas — access follows channel membership (no separate sharing), one per channel. Works on free workspaces. Bot must be a member of the channel. Same Slack-flavored markdown dialect as create_canvas. Returns canvas_id.",
		inputSchema: {
			type: "object",
			properties: {
				channel_id: {
					type: "string",
					description: "Channel ID whose canvas to create/set. Bot must be a member.",
				},
				markdown: {
					type: "string",
					description:
						"Canvas body, Slack-flavored markdown (same dialect as create_canvas).",
				},
			},
			required: ["channel_id", "markdown"],
		},
		handler: async (_session, args) => {
			const res = await canvasApi("conversations.canvases.create", {
				channel_id: args.channel_id,
				document_content: { type: "markdown", markdown: args.markdown },
			});
			return `Channel canvas created for ${args.channel_id}. canvas_id=${res.canvas_id}`;
		},
	},
	{
		name: "lookup_canvas_sections",
		description:
			"List section ids in a canvas, needed to target edit_canvas operations (insert_before/after, replace, delete). IMPORTANT: section ids are EPHEMERAL — every edit can change them, so call this immediately before each targeted edit and never reuse an id across edits. Optionally filter by heading level with `section_types`.",
		inputSchema: {
			type: "object",
			properties: {
				canvas_id: { type: "string", description: "Canvas ID (e.g. F0B7NQZ9MKP)." },
				section_types: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional filter, e.g. [\"h1\",\"h2\",\"h3\"]. Omit to return all sections.",
				},
			},
			required: ["canvas_id"],
		},
		handler: async (_session, args) => {
			const body: Record<string, unknown> = { canvas_id: args.canvas_id };
			if (Array.isArray(args.section_types) && args.section_types.length > 0) {
				body.criteria = { section_types: args.section_types };
			}
			const res = await canvasApi("canvases.sections.lookup", body);
			const sections = (res.sections ?? []) as Array<{ id: string }>;
			if (sections.length === 0) {
				return `No sections found in ${args.canvas_id}.`;
			}
			return `${sections.length} section(s) in ${args.canvas_id} (ids are ephemeral — use immediately):\n${sections.map((s) => `  ${s.id}`).join("\n")}`;
		},
	},
	{
		name: "edit_canvas",
		description:
			"Edit an existing canvas. Default appends to the end. For targeted edits (insert near / replace / delete a specific section), FIRST call lookup_canvas_sections to get a fresh section_id (they change after every edit). To rename the canvas, use operation=rename with `title`.",
		inputSchema: {
			type: "object",
			properties: {
				canvas_id: { type: "string", description: "Canvas ID." },
				operation: {
					type: "string",
					enum: [
						"insert_at_end",
						"insert_at_start",
						"insert_after",
						"insert_before",
						"replace",
						"delete",
						"rename",
					],
					description:
						"Default insert_at_end. insert_after/insert_before/delete require section_id; replace takes an optional section_id (omit to replace the whole canvas); rename uses `title`.",
				},
				markdown: {
					type: "string",
					description:
						"Slack-flavored markdown to insert/replace. Required for every operation except delete and rename.",
				},
				section_id: {
					type: "string",
					description:
						"Target section, from a FRESH lookup_canvas_sections call. Required for insert_after, insert_before, delete; optional for replace.",
				},
				title: {
					type: "string",
					description: "New canvas title — only for operation=rename.",
				},
			},
			required: ["canvas_id"],
		},
		handler: async (_session, args) => {
			const op: string = args.operation || "insert_at_end";
			const change: Record<string, unknown> = { operation: op };
			if (op === "rename") {
				if (!args.title) throw new Error("operation=rename requires `title`.");
				change.title_content = { type: "markdown", markdown: args.title };
			} else if (op === "delete") {
				if (!args.section_id)
					throw new Error("operation=delete requires `section_id`.");
				change.section_id = args.section_id;
			} else {
				if (!args.markdown)
					throw new Error(`operation=${op} requires \`markdown\`.`);
				change.document_content = { type: "markdown", markdown: args.markdown };
				if (op === "insert_after" || op === "insert_before") {
					if (!args.section_id)
						throw new Error(`operation=${op} requires \`section_id\`.`);
					change.section_id = args.section_id;
				} else if (op === "replace" && args.section_id) {
					change.section_id = args.section_id;
				}
			}
			await canvasApi("canvases.edit", {
				canvas_id: args.canvas_id,
				changes: [change],
			});
			return `Canvas ${args.canvas_id} edited (${op}).`;
		},
	},
	{
		name: "delete_canvas",
		description:
			"Delete an entire canvas by id. To remove just a section, use edit_canvas with operation=delete instead.",
		inputSchema: {
			type: "object",
			properties: {
				canvas_id: { type: "string", description: "Canvas ID to delete." },
			},
			required: ["canvas_id"],
		},
		handler: async (_session, args) => {
			await canvasApi("canvases.delete", { canvas_id: args.canvas_id });
			return `Canvas ${args.canvas_id} deleted.`;
		},
	},

	// ─── Context / lookups ────────────────────────────────────────────────────
	{
		name: "get_channel_context",
		description:
			"Read Slack conversation history. Two modes:\n\n" +
				"• **Thread mode** (pass `thread_ts`): returns ONLY that thread's messages — parent + replies. Use this whenever the user references a specific thread or you're responding to a `thread_reply` notification. Look for `meta.thread_ts` in recent `notifications/claude/channel` system reminders, or extract from a Slack thread URL.\n\n" +
				"• **Channel mode** (omit `thread_ts`): returns recent top-level activity in the channel.\n\n" +
				"Prefer thread mode any time you have a real `thread_ts` available — channel mode pulls broad noise when you only wanted one conversation. Returns compact JSON with user names resolved.\n\n" +
					"Each message includes `when` — an absolute rendered timestamp (e.g. `2026-05-27 08:54 PDT (Wed)`). Read time from `when`; it is authoritative. Do NOT convert the raw epoch `ts` to a date yourself. `when` is absolute only (no \"today/yesterday\") — compare it against your own known current date to judge recency.\n\n" +
					"Entity tokens in `text` are resolved: `<@U…>` → `@Name`, `<#C…>` → `#channel`, `<!here>` → `@here`, `<url|label>` → `label (url)`. The original is preserved on `text_raw` when a rewrite happened. Each reaction includes `users` — an array of resolved reactor display names — so you can answer 'who reacted with :tada:?' without a follow-up call.",
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

			// Entity resolution (DIG: agent-DX): batch-resolve all <@U…>/<#C…>
			// references plus reaction-users across the returned messages in one
			// parallel pass, then rewrite text + attach `reactor_names` per
			// reaction. Cache hits dominate (the bot is mentioned in nearly every
			// message and channels repeat). text_raw preserves the original so
			// no information is lost.
			const reactorIds = new Set<string>();
			for (const m of enriched as any[]) {
				if (Array.isArray(m.reactions)) {
					for (const r of m.reactions) {
						if (Array.isArray(r.users)) {
							for (const u of r.users) reactorIds.add(u);
						}
					}
				}
			}
			const entityMaps = await buildEntityMaps(
				(enriched as any[]).map((m) => m.text),
			);
			// Fold reactor lookups into the same user map so the rewriter and the
			// per-reaction reactor_names share one resolution pass.
			await Promise.all(
				[...reactorIds]
					.filter((id) => !entityMaps.users.has(id))
					.map(async (id) => {
						entityMaps.users.set(id, await getUserName(id));
					}),
			);
			const resolved = (enriched as any[]).map((m) => {
				const next: any = { ...m };
				if (typeof m.text === "string" && m.text.length > 0) {
					const rewritten = applyEntityResolution(m.text, entityMaps);
					if (rewritten !== m.text) {
						next.text_raw = m.text;
						next.text = rewritten;
					}
				}
				if (Array.isArray(m.reactions)) {
					next.reactions = m.reactions.map((r: any) => {
						if (!Array.isArray(r.users)) return r;
						const reactor_names = r.users.map(
							(u: string) => entityMaps.users.get(u) ?? u,
						);
						return { ...r, reactor_names };
					});
				}
				return next;
			});

			const out =
				fmt === "compact"
					? resolved.map(compactMessage)
					: resolved.map((m: any) =>
							m.ts ? { ...m, when: renderTimestamp(m.ts) } : m,
						);
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

	// ─── Introspection ────────────────────────────────────────────────────────
	{
		name: "bus_status",
		description:
			"Inspect the slack-bus daemon's current state: instance, uptime, bot identity, Slack connectivity, all active sessions and their subscriptions (channels + threads). The `slack` block reports the INBOUND Socket Mode link (carries replies/reactions): `connected`, `state`, and `seconds_since_last_event` — a healthy link sits in state `connected`; if it sticks off `connected` with a growing `seconds_since_last_event`, inbound is down. Outbound posting uses the Web API independently and is NOT reflected here (post failures surface per-call). Each subscription reports `expires_in_seconds` (null = session-lifetime). Each session reports `idle_seconds` (time since last HTTP request from this client) — sessions exceeding the idle threshold are reaped by the daemon. Use to diagnose 'did my notification arrive?' or to confirm which subscriptions this session currently holds. The caller's session is flagged with `is_self: true`.",
		inputSchema: {
			type: "object",
			properties: {
				include_other_sessions: {
					type: "boolean",
					description:
						"Include subscriptions from other sessions connected to the bus. Default true. Set false to only return your own session's state.",
				},
			},
		},
		handler: async (session, args) => {
			const includeOthers = args.include_other_sessions !== false;
			const myId = await getBotUserId();
			const allSessions = Array.from(sessions.values());
			const visible = includeOthers ? allSessions : allSessions.filter((s) => s.id === session.id);
			const now = Date.now();

			const subToObj = ([key, expiresAt]: [string, number | null]) => ({
				key,
				expires_in_seconds: expiresAt === null ? null : Math.max(0, Math.round((expiresAt - now) / 1000)),
			});

			const out = {
				instance: INSTANCE,
				port: PORT,
				bot_user_id: myId,
				uptime_seconds: Math.floor((now - BOOT_TIME_MS) / 1000),
				idle_reap_seconds: Math.floor(IDLE_REAP_MS / 1000),
				// Inbound Socket Mode link health (replies/reactions). Outbound
				// posting uses the Web API independently and isn't reflected here.
				slack: {
					connected: socketHealth.connected,
					state: socketHealth.state,
					seconds_since_last_event: Math.floor((now - socketHealth.lastEventAt) / 1000),
					last_connected_seconds_ago:
						socketHealth.lastConnectedAt === null
							? null
							: Math.floor((now - socketHealth.lastConnectedAt) / 1000),
					last_disconnected_seconds_ago:
						socketHealth.lastDisconnectedAt === null
							? null
							: Math.floor((now - socketHealth.lastDisconnectedAt) / 1000),
					connect_count: socketHealth.connectCount,
					disconnect_count: socketHealth.disconnectCount,
				},
				current_session_id: session.id,
				session_count: allSessions.length,
				visible_session_count: visible.length,
				sessions: visible.map((s) => ({
					id: s.id,
					is_self: s.id === session.id,
					idle_seconds: Math.floor((now - s.lastSeen) / 1000),
					channels: Array.from(s.channels).map(subToObj),
					threads: Array.from(s.threads).map(subToObj),
				})),
			};
			return JSON.stringify(out, null, 2);
		},
	},
	{
		name: "open_slack",
		description:
			"Launch or focus the Slack desktop app on the host Mac (runs `open -a Slack`). For dogfooding — bring Slack to the foreground from a Claude session. Note: this controls the LOCAL desktop client only and has no bearing on message delivery — the bus talks to Slack's cloud independently of whether the desktop app is open.",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			if (process.platform !== "darwin") {
				throw new Error(
					`open_slack is macOS-only (host platform is ${process.platform}).`,
				);
			}
			// `open -a` launches the app or focuses it if already running.
			const proc = Bun.spawn(["open", "-a", "Slack"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await proc.exited;
			if (code !== 0) {
				const stderr = (await new Response(proc.stderr).text()).trim();
				throw new Error(
					`open -a Slack failed (exit ${code})${stderr ? `: ${stderr}` : " — is Slack installed?"}`,
				);
			}
			return "Slack desktop app launched/focused.";
		},
	},
];

// ─── Per-session MCP server factory ───────────────────────────────────────────

// Build a fresh transport+server pair for a session. With no argument this is a
// brand-new session (sid minted on `initialize`). With `adoptId`, it RE-ADOPTS an
// existing sid arriving on a GET reconnect the bus no longer knows about — see the
// adoption block at the end of this function and the fetch handler's re-adopt fork.
function buildSessionServer(adoptId?: string): {
	transport: WebStandardStreamableHTTPServerTransport;
	server: Server;
	getSessionId: () => string;
} {
	// Seed with adoptId so the tool-call handler (sessions.get(assignedId)) routes
	// correctly on a re-adopted session, where onsessioninitialized never fires.
	let assignedId = adoptId ?? "";
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: (sid) => {
			assignedId = sid;
			log(`session initialized: ${sid}`);
			const session: Session = {
				id: sid,
				server,
				transport,
				threads: new Map(),
				channels: new Map(),
				lastSeen: Date.now(),
			};
			sessions.set(sid, session);
		},
		onsessionclosed: (sid) => {
			const s = sessions.get(sid);
			if (s) {
				log(
					`session closed: ${sid}, retaining ${s.threads.size} thread + ${s.channels.size} channel sub(s) for re-adoption`,
				);
				// Preserve subs before dropping — Claude Code doesn't send DELETE
				// today, but if a clean close ever fires we still want a reconnect
				// to be able to rehydrate. (Idle-reaper path retains too.)
				retainSubs(s);
				sessions.delete(sid);
			}
		},
	});

	const server = new Server(
		{ name: `slack-bus-${INSTANCE}`, version: VERSION },
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
		const args = req.params.arguments ?? {};
		try {
			const text = await tool.handler(session, args as any);
			return { content: [{ type: "text", text }] };
		} catch (err) {
			const { category, message } = classifyError(err);
			logError(
				`tool=${tool.name} session=${session.id.slice(0, 8)} category=${category} args=${inspectArgs(args)} err=${message}`,
			);
			return {
				content: [{ type: "text", text: `Error: ${message}` }],
				isError: true,
			};
		}
	});

	void server.connect(transport);

	// ─── Re-adoption ──────────────────────────────────────────────────────────
	// No real `initialize` fires for an adopted transport, so onsessioninitialized
	// never runs and the SDK's validateSession would 404 a GET carrying this sid.
	// Coerce the transport into the post-init state the SDK demands (sessionId match
	// + _initialized), then register + rehydrate the session ourselves. Mechanism
	// measured in channels-lab (FINDINGS.md): answering the unknown-sid GET with
	// 200 + this coerced live stream restores render+routing on a real client; the
	// 200-vs-404 difference is causal. The private-field pokes are pinned to the
	// vendored SDK version — guarded here and re-verify on SDK bumps.
	if (adoptId) {
		transport.sessionId = adoptId;
		(transport as unknown as { _initialized: boolean })._initialized = true;
		const restored = takeRetainedSubs(adoptId);
		const session: Session = {
			id: adoptId,
			server,
			transport,
			threads: restored?.threads ?? new Map(),
			channels: restored?.channels ?? new Map(),
			lastSeen: Date.now(),
		};
		sessions.set(adoptId, session);
		log(
			`session RE-ADOPTED: ${adoptId} (coerced _initialized; rehydrated ${session.threads.size} thread + ${session.channels.size} channel sub(s)${restored ? "" : " — none retained"})`,
		);
	}

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

		// Test-only debug levers (DIG-279 re-adopt validation), gated behind
		// SLACK_BUS_DEBUG_LEVERS — inert in production. Lets a real claude-code
		// receiver be driven (forget / push render-proof / inspect) without Slack.
		if (process.env.SLACK_BUS_DEBUG_LEVERS === "1" && url.pathname.startsWith("/debug/")) {
			if (url.pathname === "/debug/sessions") {
				return Response.json({
					openSessions: sessions.size,
					sessions: [...sessions.values()].map((s) => ({
						id: s.id,
						threads: [...s.threads.keys()],
						channels: [...s.channels.keys()],
						idleSec: Math.round((Date.now() - s.lastSeen) / 1000),
					})),
					retained: [...retainedSubs.entries()].map(([sid, r]) => ({
						id: sid,
						threads: [...r.threads.keys()],
						channels: [...r.channels.keys()],
					})),
				});
			}
			if (url.pathname.startsWith("/debug/forget/")) {
				// Drop a session + close its SSE stream WITHOUT restarting the daemon
				// (isolates "bus forgot you" from "process died"). Retains subs first
				// so a reconnect can rehydrate — the path under test.
				const sid = decodeURIComponent(url.pathname.slice("/debug/forget/".length));
				const s = sessions.get(sid);
				if (!s) return new Response("unknown sid", { status: 404 });
				retainSubs(s);
				(s.transport as unknown as { closeStandaloneSSEStream?: () => void }).closeStandaloneSSEStream?.();
				sessions.delete(sid);
				log(`[debug] FORGOT ${sid} (closed stream + dropped; daemon stays up)`);
				return Response.json({ ok: true, forgot: sid });
			}
			if (url.pathname.startsWith("/debug/push/")) {
				// Fire one channel notification at a session (render proof without Slack).
				const sid = decodeURIComponent(url.pathname.slice("/debug/push/".length));
				const s = sessions.get(sid);
				if (!s) return new Response("unknown sid", { status: 404 });
				const marker = url.searchParams.get("m") ?? "x";
				await s.server.notification({
					method: "notifications/claude/channel",
					params: {
						content: `slack-bus re-adopt probe [marker ${marker}] — to confirm you RENDERED this, call the bus_status tool now.`,
						meta: { source: "slack-bus-test", kind: "selftest", marker },
					},
				});
				log(`[debug] pushed marker=${marker} → ${sid} (send resolved; render unproven until a tool call returns on this sid)`);
				return Response.json({ ok: true, marker, sid });
			}
			return new Response("unknown debug lever", { status: 404 });
		}

		if (url.pathname !== "/mcp") {
			return new Response("not found", { status: 404 });
		}

		const sessionId = req.headers.get("mcp-session-id") ?? undefined;

		// Existing session: route to its transport, bump lastSeen so the idle
		// reaper doesn't kill us. Any HTTP request to this session counts as
		// liveness — initialize, tool calls, the long-lived GET SSE stream.
		if (sessionId && sessions.has(sessionId)) {
			const s = sessions.get(sessionId)!;
			s.lastSeen = Date.now();
			log(`req method=${req.method} session=${sessionId.slice(0, 8)}…`);
			return s.transport.handleRequest(req);
		}

		// Unknown-but-present sid on a GET event-stream = a reconnect the bus no
		// longer knows about. The live client kept its sid and is reopening its SSE
		// push pipe after the bus forgot it (idle-reaped, a clean close, or — the
		// case that matters most for slack-bus — a daemon restart/kickstart). The
		// SDK would 404 this, which a real claude-code client treats as fatal: it
		// retries the GET twice (~1.5s) then abandons the push stream for good. POST
		// keeps working, so the session looks healthy while silently rendering
		// nothing — the DIG-279 zombie. Re-adopt instead: answer 200 with a fresh
		// live stream coerced onto the same sid (and rehydrate its subs). channels-lab
		// measured this recovers render+routing on a real client; 200-vs-404 is causal.
		const accept = req.headers.get("accept") ?? "";
		const isStream = accept.includes("text/event-stream");
		if (sessionId && isStream && req.method === "GET") {
			log(`re-adopt: unknown sid ${sessionId.slice(0, 8)}… on GET stream → 200 + fresh live stream`);
			const { transport } = buildSessionServer(sessionId);
			const resp = await transport.handleRequest(req);
			// Priming flush: enqueue an ignored SSE comment so 200 status+headers
			// reach the client immediately. channels-lab measured this is NOT required
			// on Bun.serve (Bun flushes headers when the streaming Response returns)
			// but IS load-bearing on runtimes that withhold headers until first byte.
			// Kept as harmless insurance so a future move off Bun stays safe.
			try {
				const t = transport as unknown as {
					_streamMapping?: Map<string, { controller?: { enqueue: (b: Uint8Array) => void }; encoder: TextEncoder }>;
					_standaloneSseStreamId?: string;
				};
				const entry = t._streamMapping?.get(t._standaloneSseStreamId ?? "");
				entry?.controller?.enqueue(entry.encoder.encode(": slack-bus-readopt-priming\n\n"));
			} catch (e) {
				log(`re-adopt priming flush failed for ${sessionId.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`);
			}
			return resp;
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

// ─── Idle reaper ──────────────────────────────────────────────────────────────
// Sweeps every REAPER_INTERVAL_MS:
//   1. Prune individually-expired subscriptions (TTL'd subs whose deadline passed).
//   2. Drop sessions that have been idle longer than IDLE_REAP_MS — these are
//      almost certainly clients that exited without sending MCP DELETE
//      (see DIG-203). The transport.close() call is best-effort; if the
//      underlying SSE stream is already dead, the throw is expected.
setInterval(() => {
	const now = Date.now();
	for (const session of Array.from(sessions.values())) {
		const droppedSubs =
			pruneExpiredSubs(session.threads, now) +
			pruneExpiredSubs(session.channels, now);
		if (droppedSubs > 0) {
			log(`reaper: session ${session.id} dropped ${droppedSubs} expired sub(s)`);
		}

		if (isIdleExpired(session.lastSeen, IDLE_REAP_MS, now)) {
			const idleStr = formatIdle(now - session.lastSeen);
			log(
				`session reaped (idle ${idleStr}): ${session.id}, retaining ${session.threads.size} thread + ${session.channels.size} channel sub(s) for re-adoption`,
			);
			// Retain subs so a still-running client that reconnects with this sid can
			// rehydrate (see retainedSubs / the fetch handler re-adopt fork, DIG-279).
			retainSubs(session);
			sessions.delete(session.id);
			// Best-effort: tell the transport to close. The underlying SSE
			// stream is usually already dead at this point, so both sync
			// throws and async rejections are expected and swallowed.
			try {
				Promise.resolve(session.transport.close?.()).catch(() => {
					// intentional no-op — transport already torn down
				});
			} catch {
				// intentional no-op — close() threw synchronously
			}
		}
	}

	// Sweep retained subs that were never reclaimed by a reconnect (the client is
	// really gone). takeRetainedSubs() also TTL-guards on reclaim; this bounds the
	// map for sids that simply never come back.
	for (const [sid, r] of Array.from(retainedSubs.entries())) {
		if (now - r.retainedAt > RETAINED_SUBS_TTL_MS) {
			retainedSubs.delete(sid);
			log(`retained subs expired (never reconnected): ${sid}`);
		}
	}
}, REAPER_INTERVAL_MS);

// ─── Start ────────────────────────────────────────────────────────────────────

// Visual separator + key facts. When the log spans multiple restarts (which
// it always does, since /tmp/slack-bus-*.log isn't rotated), this banner is
// the easiest way to find the boot you care about.
log("═".repeat(72));
log(
	`slack-bus v${VERSION} starting — instance=${INSTANCE} port=${PORT} pid=${process.pid} bun=${process.versions.bun ?? "?"}`,
);
log(
	`config — idle_reap=${IDLE_REAP_MS / 1000}s reaper_interval=${REAPER_INTERVAL_MS / 1000}s log=${LOG_FILE}`,
);

// Test harness only (DIG-279 re-adopt validation): boot HTTP-transport-only with
// no Socket Mode, so a test instance on a spare port never contends for the
// exclusive per-app-token Slack socket held by the live daemon. Inert in prod.
if (process.env.SLACK_BUS_NO_SLACK === "1") {
	log("SLACK_BUS_NO_SLACK=1 — skipping Socket Mode (HTTP transport only; test harness)");
} else {
	await slackApp.start();
	const myId = await getBotUserId();
	log(`Slack Socket Mode connected. bot_user_id=${myId}`);
}
log(`listening on http://localhost:${PORT}/mcp`);
log(`slack-bus v${VERSION} ready`);

function shutdown(sig: string) {
	log(`received ${sig}, shutting down`);
	process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
