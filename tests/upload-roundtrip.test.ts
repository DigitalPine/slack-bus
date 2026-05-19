/**
 * Round-trip: upload_image → get_image_from_slack → byte-match.
 *
 * The cheapest high-confidence smoke test for the file API pair. Catches
 * regressions in either tool, the SDK plumbing, or notification framing.
 *
 * Requires a running bus on SLACK_BUS_TEST_URL (defaults to digitalpine on
 * 42001). Skips if unreachable so this doesn't fail in environments without
 * tokens.
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { tryConnectMcp } from "./lib/mcp-http-client";

const URL = process.env.SLACK_BUS_TEST_URL ?? "http://localhost:42001/mcp";
const FIXTURE = `${import.meta.dir}/fixtures/pixel.png`;

describe("upload_image ↔ get_image_from_slack", () => {
	it("round-trips bytes through Slack file storage", async () => {
		const client = await tryConnectMcp(URL);
		if (!client) {
			console.warn(`bus not reachable at ${URL} — skipping`);
			return;
		}

		// Upload (no channel — just stage the file, get an ID back).
		const uploadText = await client.callTool("upload_image", {
			file_path: FIXTURE,
			title: "roundtrip-test",
		});
		const fileId = uploadText.match(/file_id=([A-Z0-9]+)/)?.[1];
		expect(fileId).toBeDefined();

		// Download.
		const downloadText = await client.callTool("get_image_from_slack", {
			file_id: fileId!,
		});
		const localPath = downloadText.match(/Image downloaded to: (\/\S+)/)?.[1];
		expect(localPath).toBeDefined();

		// Byte-match.
		const original = await readFile(FIXTURE);
		const round = await readFile(localPath!);
		expect(round.length).toBe(original.length);
		expect(Buffer.compare(original, round)).toBe(0);

		client.close();
	}, 30_000);

	it("tools/list returns the 21-tool surface", async () => {
		const client = await tryConnectMcp(URL);
		if (!client) {
			console.warn(`bus not reachable at ${URL} — skipping`);
			return;
		}

		const tools = await client.listTools();
		// Spot-check key tools rather than asserting the exact count — count
		// will change as reactions/bus_status land.
		const expected = [
			"post_message",
			"upload_image",
			"get_image_from_slack",
			"get_channel_context",
			"subscribe_channel",
			"subscribe_thread",
			"start_stream",
			"set_thread_status",
		];
		for (const name of expected) {
			expect(tools).toContain(name);
		}

		client.close();
	});
});
