/**
 * Resolve Slack-flavored mrkdwn entity tokens into human-legible text.
 *
 * Slack delivers message bodies with machine-encoded entity tokens:
 *   <@U0123>            bare user mention (no fallback in real-world data)
 *   <@U0123|joel>       user mention with display fallback
 *   <#C0456>            bare channel link
 *   <#C0456|general>    channel link with name
 *   <!subteam^S0|@team> user-group ping
 *   <!here>             broadcast pings
 *   <https://x|label>   labeled link
 *   <https://x>         bare link
 *
 * The consumer of slack-bus tool output is an LLM agent (see
 * [[feedback-mcp-tool-output-is-llm-consumed]] / "the connected agent is the
 * user" in CLAUDE.md). Raw `<@U0123>` forces the agent to either lookup-or-
 * guess identity inline, and 99% of the time it just won't. Resolving up-front
 * in the daemon trades a tiny lookup cost for a large legibility win.
 *
 * This module is pure (no I/O) by design — split into:
 *   extractEntityIds(text)                 → { userIds, channelIds }
 *   applyEntityResolution(text, maps)      → resolved string
 *
 * The caller (bus-mcp.ts) does the batch resolution via the existing
 * userCache/channelCache between the two steps. Pure split makes the
 * substitution logic unit-testable without faking the Slack web API.
 *
 * Failure mode: any unknown id falls back to the bare id (e.g. `@U0123`) — a
 * lookup miss never throws and never drops the token entirely. Better to show
 * the agent something it can still pass back to a tool than to swallow it.
 */

const ENTITY_TOKEN = /<([^>]+)>/g;

export type EntityIds = {
	userIds: Set<string>;
	channelIds: Set<string>;
};

export type EntityMaps = {
	users: Map<string, string>; // U-id → display name (without leading @)
	channels: Map<string, string>; // C-id → channel name (without leading #)
};

/**
 * Walk the message text and collect the bare user/channel ids that need
 * resolution. Tokens carrying an inline `|fallback` are skipped here — we'll
 * use the fallback directly at apply-time, no lookup needed.
 */
export function extractEntityIds(text: string): EntityIds {
	const userIds = new Set<string>();
	const channelIds = new Set<string>();
	if (!text) return { userIds, channelIds };

	for (const match of text.matchAll(ENTITY_TOKEN)) {
		const inner = match[1];
		if (!inner) continue;
		// Inline fallback present → no lookup needed.
		if (inner.includes("|")) continue;

		if (inner.startsWith("@U") || inner.startsWith("@W")) {
			// <@U123> — user mention. Slack user ids start with U (humans/bots) or W (workspace-shared org users).
			userIds.add(inner.slice(1));
		} else if (inner.startsWith("#C") || inner.startsWith("#G") || inner.startsWith("#D")) {
			// <#C123> — channel link. C=public, G=private (legacy), D=DM.
			channelIds.add(inner.slice(1));
		}
		// Everything else (<!here>, <!subteam^...>, bare URLs) needs no lookup
		// and is handled inline by applyEntityResolution.
	}
	return { userIds, channelIds };
}

/**
 * Substitute entity tokens in `text` with human-legible forms.
 *
 * The `maps` argument provides resolved names for the ids extracted earlier.
 * Missing entries are NOT an error — they fall back to the bare id rendered
 * as `@U0123` / `#C0456` so the agent retains the original handle for follow-
 * up tool calls.
 */
export function applyEntityResolution(text: string, maps: EntityMaps): string {
	if (!text) return text;

	const resolved = text.replace(ENTITY_TOKEN, (whole, rawInner: string) => {
		const inner = rawInner ?? "";
		if (!inner) return whole;
		// User mention: <@U0123> or <@U0123|fallback>
		if (inner.startsWith("@U") || inner.startsWith("@W")) {
			const parts = inner.slice(1).split("|");
			const id = parts[0] ?? "";
			const fallback = parts[1];
			if (fallback) return `@${fallback}`;
			const name = maps.users.get(id);
			return name ? `@${name}` : `@${id}`;
		}

		// Channel link: <#C0456> or <#C0456|name>
		if (inner.startsWith("#C") || inner.startsWith("#G") || inner.startsWith("#D")) {
			const parts = inner.slice(1).split("|");
			const id = parts[0] ?? "";
			const fallback = parts[1];
			if (fallback) return `#${fallback}`;
			const name = maps.channels.get(id);
			return name ? `#${name}` : `#${id}`;
		}

		// Special mentions: <!here>, <!channel>, <!everyone>, <!subteam^S0|@team>
		if (inner.startsWith("!")) {
			const body = inner.slice(1);
			if (body === "here" || body === "channel" || body === "everyone") {
				return `@${body}`;
			}
			// <!subteam^S123|@team> — fallback after | is the group's handle.
			if (body.startsWith("subteam^")) {
				const pipe = body.indexOf("|");
				if (pipe !== -1) {
					const handle = body.slice(pipe + 1);
					return handle.startsWith("@") ? handle : `@${handle}`;
				}
				// Bare subteam with no fallback: surface a marker rather than the raw id.
				return "@group";
			}
			// <!date^1234^{date_short}|fallback> — Slack date tokens. The text after | is
			// the human fallback; before it is a template the bot would normally render.
			const pipe = body.indexOf("|");
			if (pipe !== -1) return body.slice(pipe + 1);
			return whole; // Unknown !-token: leave as-is, never throw.
		}

		// Mailto: <mailto:foo@bar|label> or <mailto:foo@bar>
		if (inner.startsWith("mailto:")) {
			const parts = inner.slice("mailto:".length).split("|");
			const addr = parts[0] ?? "";
			const label = parts[1];
			return label || addr;
		}

		// URL link: <https://example.com|label> or <https://example.com>
		if (/^https?:\/\//.test(inner) || inner.startsWith("www.")) {
			const pipe = inner.indexOf("|");
			if (pipe !== -1) {
				const url = inner.slice(0, pipe);
				const label = inner.slice(pipe + 1);
				return `${label} (${url})`;
			}
			return inner;
		}

		// Unknown token shape — leave untouched. We only rewrite what we
		// affirmatively understand, so we never garble exotic markup.
		return whole;
	});

	// Slack escapes &, <, > in delivered text so its own tokenizer doesn't
	// re-parse them. Reverse after token resolution so the agent reads natural
	// punctuation rather than HTML entities.
	return resolved.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * Convenience: extract → apply in one call given a pre-populated maps object.
 * Most callers use the two-step form (extract for batch lookup, apply after);
 * this exists for tests and for code paths where maps are already in hand.
 */
export function resolveEntities(text: string, maps: EntityMaps): string {
	return applyEntityResolution(text, maps);
}
