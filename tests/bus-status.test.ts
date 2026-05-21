/**
 * bus_status returns a snapshot of daemon + subscription state. Smoke-test the
 * shape, that the caller's session is flagged is_self, and that a freshly-made
 * subscription shows up.
 */

import { describe, expect, it } from "bun:test";
import { tryConnectMcp } from "./lib/mcp-http-client";

const URL = process.env.SLACK_BUS_TEST_URL ?? "http://localhost:42001/mcp";

describe("bus_status", () => {
	it("reports daemon metadata + sessions, flags self, includes new subscriptions", async () => {
		const client = await tryConnectMcp(URL);
		if (!client) {
			console.warn(`bus not reachable at ${URL} — skipping`);
			return;
		}

		// Subscribe to a fake channel so we can see it in the output.
		const fakeChannel = "CTESTCHANNEL01";
		await client.callTool("subscribe_channel", { channel_id: fakeChannel });

		const statusText = await client.callTool("bus_status", {});
		const status = JSON.parse(statusText) as {
			instance: string;
			port: number;
			bot_user_id: string;
			uptime_seconds: number;
			current_session_id: string;
			session_count: number;
			sessions: Array<{ id: string; is_self: boolean; channels: string[]; threads: string[] }>;
		};

		expect(typeof status.instance).toBe("string");
		expect(typeof status.port).toBe("number");
		expect(status.bot_user_id).toMatch(/^U/);
		expect(status.uptime_seconds).toBeGreaterThanOrEqual(0);
		expect(status.current_session_id).toBe(client.sessionId);
		expect(status.session_count).toBeGreaterThanOrEqual(1);

		const self = status.sessions.find((s) => s.is_self);
		expect(self).toBeDefined();
		expect(self!.id).toBe(client.sessionId);
		expect(self!.channels).toContain(fakeChannel);

		client.close();
	});

	it("include_other_sessions=false scopes to caller", async () => {
		const client = await tryConnectMcp(URL);
		if (!client) {
			console.warn(`bus not reachable at ${URL} — skipping`);
			return;
		}

		const statusText = await client.callTool("bus_status", {
			include_other_sessions: false,
		});
		const status = JSON.parse(statusText) as {
			visible_session_count: number;
			sessions: Array<{ is_self: boolean }>;
		};

		expect(status.visible_session_count).toBe(1);
		expect(status.sessions.length).toBe(1);
		expect(status.sessions[0]!.is_self).toBe(true);

		client.close();
	});
});
