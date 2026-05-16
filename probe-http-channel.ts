#!/usr/bin/env bun
/**
 * Probe: does Claude Code surface `notifications/claude/channel` notifications
 * when the MCP server speaks Streamable HTTP transport (not stdio)?
 *
 * Run:
 *   bun probe-http-channel.ts
 *
 * Then add to a project's .mcp.json:
 *   "probe-bus": { "type": "http", "url": "http://localhost:42100/mcp" }
 *
 * Launch Claude with:
 *   claude --dangerously-load-development-channels server:probe-bus
 *
 * In Claude, call `ping_me`. After ~3s a notification fires. If it surfaces
 * as a system reminder, dev-channels work over HTTP and we can merge.
 *
 * Logs every connection's sessionId — proves per-session identity works.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

const PORT = 42100;

type Slot = {
	transport: WebStandardStreamableHTTPServerTransport;
	server: Server;
	sessionId: string;
};
const slots = new Map<string, Slot>();

function log(msg: string) {
	console.log(`[${new Date().toISOString()}] ${msg}`);
}

log(`probe-bus listening on http://localhost:${PORT}/mcp`);

Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	// SSE streams from MCP Streamable HTTP must stay open indefinitely so the
	// server can push notifications. Bun's default 10s idle timeout closes
	// them prematurely — notifications fire into a dead pipe.
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname !== "/mcp") {
			return new Response("not found", { status: 404 });
		}

		const sessionId = req.headers.get("mcp-session-id") ?? undefined;

		// Existing session — route to its transport.
		if (sessionId && slots.has(sessionId)) {
			const slot = slots.get(sessionId)!;
			log(`req method=${req.method} session=${sessionId} (existing)`);
			return slot.transport.handleRequest(req);
		}

		// New session: only valid on POST (initialize). Build a transport+server pair.
		if (req.method !== "POST") {
			return new Response("missing or unknown mcp-session-id", { status: 400 });
		}

		log(`new connection — building session…`);

		// Build the real per-session server that closes over its own sessionId.
		// We can't know sessionId until onsessioninitialized fires, so we use a
		// late-bound ref the request handlers read.
		let assignedId = "";
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (sid) => {
				assignedId = sid;
				log(`session initialized: ${sid}`);
				slots.set(sid, { transport, server, sessionId: sid });
			},
			onsessionclosed: (sid) => {
				log(`session closed: ${sid}`);
				slots.delete(sid);
			},
		});

		const server = new Server(
			{ name: "probe-bus", version: "0.0.1" },
			{
				capabilities: {
					experimental: { "claude/channel": {} },
					tools: {},
				},
				instructions:
					"Probe MCP server testing HTTP transport + notifications/claude/channel.",
			},
		);

		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [
				{
					name: "ping_me",
					description:
						"Schedule a notifications/claude/channel notification to fire after `delay_seconds` (default 3). If Claude Code surfaces it as a system reminder, dev-channels work over HTTP transport.",
					inputSchema: {
						type: "object" as const,
						properties: {
							delay_seconds: { type: "number" },
							message: { type: "string" },
						},
					},
				},
				{
					name: "whoami",
					description:
						"Returns the current MCP session id. Confirms each Claude connection has a unique server-side identity.",
					inputSchema: { type: "object" as const, properties: {} },
				},
			],
		}));

		server.setRequestHandler(CallToolRequestSchema, async (req) => {
			const sid = assignedId || "(uninitialized)";
			if (req.params.name === "whoami") {
				return {
					content: [{ type: "text", text: `sessionId=${sid}` }],
				};
			}
			if (req.params.name === "ping_me") {
				const args = (req.params.arguments ?? {}) as {
					delay_seconds?: number;
					message?: string;
				};
				const delaySec = args.delay_seconds ?? 3;
				const text = args.message ?? `probe ping — sessionId=${sid}`;

				log(`session=${sid} ping_me scheduled in ${delaySec}s: "${text}"`);
				setTimeout(() => {
					log(`session=${sid} dispatching notification`);
					void server
						.notification({
							method: "notifications/claude/channel",
							params: {
								content: text,
								meta: {
									source: "probe-bus",
									kind: "probe_ping",
									sessionId: sid,
									channel_id: "CPROBE",
									channel_name: "probe",
									thread_ts: String(Date.now() / 1000),
									ts: String(Date.now() / 1000),
									user_id: "UPROBE",
									user_name: "Probe",
								},
							},
						})
						.then(() => log(`session=${sid} notification sent OK`))
						.catch((err) =>
							log(`session=${sid} notification FAILED: ${err}`),
						);
				}, delaySec * 1000);

				return {
					content: [
						{
							type: "text",
							text: `Scheduled notification in ${delaySec}s. sessionId=${sid}. Watch this session for a system reminder.`,
						},
					],
				};
			}
			throw new Error(`unknown tool: ${req.params.name}`);
		});

		await server.connect(transport);
		return transport.handleRequest(req);
	},
});
