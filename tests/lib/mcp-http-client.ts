/**
 * Tiny MCP Streamable HTTP client for tests.
 *
 * Only what we need: initialize → notifications/initialized → tools/call.
 * SSE response framing is `event: message\ndata: <json>\n\n` — we parse the
 * first `data:` line and ignore keepalives.
 */

export type McpClient = {
	sessionId: string;
	callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
	listTools: () => Promise<string[]>;
	close: () => void;
};

const ACCEPT = "application/json, text/event-stream";

function parseSseDataLine(body: string): unknown {
	// Body shape: "event: message\ndata: <json>\n\n..." (possibly multiple)
	const dataLine = body.split("\n").find((l) => l.startsWith("data: "));
	if (!dataLine) {
		throw new Error(`expected SSE data line in body: ${body.slice(0, 200)}`);
	}
	return JSON.parse(dataLine.slice("data: ".length));
}

function unwrapToolText(result: unknown): string {
	// tools/call response: { result: { content: [{ type: "text", text: "..." }] } }
	const r = result as {
		result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
		error?: { message: string };
	};
	if (r.error) throw new Error(`MCP error: ${r.error.message}`);
	const first = r.result?.content?.[0];
	if (!first || first.type !== "text" || typeof first.text !== "string") {
		throw new Error(`unexpected tool result shape: ${JSON.stringify(result).slice(0, 200)}`);
	}
	if (r.result?.isError) throw new Error(`tool returned error: ${first.text}`);
	return first.text;
}

export async function connectMcp(url: string): Promise<McpClient> {
	let nextId = 1;
	const id = () => nextId++;

	// initialize
	const initRes = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: ACCEPT },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: id(),
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "slack-bus-tests", version: "0" },
			},
		}),
	});
	const sessionId = initRes.headers.get("mcp-session-id");
	if (!sessionId) {
		throw new Error(`no mcp-session-id header from ${url} (status ${initRes.status})`);
	}
	// Drain init body so the connection settles.
	await initRes.text();

	const headers = {
		"Content-Type": "application/json",
		Accept: ACCEPT,
		"mcp-session-id": sessionId,
	};

	await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	});

	return {
		sessionId,
		async callTool(name, args) {
			const res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: id(),
					method: "tools/call",
					params: { name, arguments: args },
				}),
			});
			const body = await res.text();
			return unwrapToolText(parseSseDataLine(body));
		},
		async listTools() {
			const res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", id: id(), method: "tools/list" }),
			});
			const body = await res.text();
			const parsed = parseSseDataLine(body) as {
				result?: { tools?: Array<{ name: string }> };
			};
			return (parsed.result?.tools ?? []).map((t) => t.name);
		},
		close() {
			// No persistent stream to tear down; sessions linger on the bus until
			// it's restarted (see DIG-203 — onsessionclosed never fires).
		},
	};
}

/**
 * Returns null if no bus is reachable at the URL. Tests can skip on null.
 */
export async function tryConnectMcp(url: string): Promise<McpClient | null> {
	try {
		return await connectMcp(url);
	} catch {
		return null;
	}
}
