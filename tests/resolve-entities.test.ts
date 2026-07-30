/**
 * Unit tests for resolve-entities. The module is pure; we stub the lookup maps
 * directly so the tests cover the substitution logic without faking the Slack
 * web API. Failure-mode coverage (missing id, unknown token, empty input)
 * matches the discipline established by format-time/classify-error/lifecycle.
 */

import { describe, expect, it } from "bun:test";
import {
	applyEntityResolution,
	extractEntityIds,
	resolveEntities,
} from "../resolve-entities.ts";

function maps(
	users: Record<string, string> = {},
	channels: Record<string, string> = {},
) {
	return {
		users: new Map(Object.entries(users)),
		channels: new Map(Object.entries(channels)),
	};
}

describe("extractEntityIds", () => {
	it("collects bare user mentions", () => {
		const { userIds, channelIds } = extractEntityIds(
			"hey <@U0AJT866EP4> and <@U123ABC>",
		);
		expect([...userIds].sort()).toEqual(["U0AJT866EP4", "U123ABC"]);
		expect(channelIds.size).toBe(0);
	});

	it("collects bare channel links", () => {
		const { userIds, channelIds } = extractEntityIds(
			"see <#C0B5E5GQBBJ> and <#C999>",
		);
		expect([...channelIds].sort()).toEqual(["C0B5E5GQBBJ", "C999"]);
		expect(userIds.size).toBe(0);
	});

	it("skips tokens that carry inline fallback (no lookup needed)", () => {
		const { userIds, channelIds } = extractEntityIds(
			"<@U1|joel> in <#C2|general>",
		);
		expect(userIds.size).toBe(0);
		expect(channelIds.size).toBe(0);
	});

	it("ignores broadcast pings and bare URLs", () => {
		const { userIds, channelIds } = extractEntityIds(
			"<!here> ping <https://x.com|x>",
		);
		expect(userIds.size).toBe(0);
		expect(channelIds.size).toBe(0);
	});

	it("returns empty sets for empty input", () => {
		const r = extractEntityIds("");
		expect(r.userIds.size).toBe(0);
		expect(r.channelIds.size).toBe(0);
	});

	it("dedupes repeated ids", () => {
		const { userIds } = extractEntityIds("<@U1> hi <@U1> and <@U1>");
		expect([...userIds]).toEqual(["U1"]);
	});
});

describe("applyEntityResolution — user mentions", () => {
	it("resolves a bare user mention via the lookup map", () => {
		expect(
			applyEntityResolution("hi <@U1>", maps({ U1: "Joel Brubaker" })),
		).toBe("hi @Joel Brubaker");
	});

	it("uses inline fallback over the lookup map", () => {
		expect(
			applyEntityResolution("hi <@U1|joel>", maps({ U1: "WRONG" })),
		).toBe("hi @joel");
	});

	it("falls back to bare id when the lookup is missing", () => {
		expect(applyEntityResolution("hi <@U1>", maps())).toBe("hi @U1");
	});
});

describe("applyEntityResolution — channel links", () => {
	it("resolves a bare channel via the lookup map", () => {
		expect(
			applyEntityResolution("see <#C1>", maps({}, { C1: "general" })),
		).toBe("see #general");
	});

	it("uses inline channel-name fallback", () => {
		expect(applyEntityResolution("see <#C1|hub>", maps())).toBe("see #hub");
	});

	it("falls back to bare id when the channel lookup is missing", () => {
		expect(applyEntityResolution("see <#C1>", maps())).toBe("see #C1");
	});
});

describe("applyEntityResolution — special tokens", () => {
	it("renders broadcast pings as @here/@channel/@everyone", () => {
		expect(applyEntityResolution("<!here> <!channel> <!everyone>", maps())).toBe(
			"@here @channel @everyone",
		);
	});

	it("renders a user-group with handle fallback", () => {
		expect(
			applyEntityResolution("<!subteam^S123|@oncall>", maps()),
		).toBe("@oncall");
	});

	it("renders a bare subteam as @group", () => {
		expect(applyEntityResolution("<!subteam^S123>", maps())).toBe("@group");
	});

	it("uses the human fallback after | in a date token", () => {
		expect(
			applyEntityResolution(
				"due <!date^1234567890^{date_short}|Jan 1, 2026>",
				maps(),
			),
		).toBe("due Jan 1, 2026");
	});
});

describe("applyEntityResolution — URLs and email", () => {
	it("renders labeled links as 'label (url)'", () => {
		expect(
			applyEntityResolution("docs at <https://example.com|here>", maps()),
		).toBe("docs at here (https://example.com)");
	});

	it("strips brackets from a bare URL", () => {
		expect(applyEntityResolution("see <https://example.com>", maps())).toBe(
			"see https://example.com",
		);
	});

	it("renders mailto with label", () => {
		expect(
			applyEntityResolution(
				"<mailto:joel@example.com|Joel>",
				maps(),
			),
		).toBe("Joel");
	});

	it("renders bare mailto as the address", () => {
		expect(
			applyEntityResolution("<mailto:joel@example.com>", maps()),
		).toBe("joel@example.com");
	});
});

describe("applyEntityResolution — entity unescape", () => {
	it("unescapes &amp; &lt; &gt; after substitution", () => {
		expect(
			applyEntityResolution("Rock &amp; Roll &lt;3", maps()),
		).toBe("Rock & Roll <3");
	});
});

describe("applyEntityResolution — never-throw discipline", () => {
	it("returns empty input unchanged", () => {
		expect(applyEntityResolution("", maps())).toBe("");
	});

	it("leaves an unknown token shape untouched", () => {
		expect(
			applyEntityResolution("weird <something_strange>", maps()),
		).toBe("weird <something_strange>");
	});

	it("survives nested-looking content", () => {
		// Slack would never deliver this shape, but a bug shouldn't crash routing.
		expect(applyEntityResolution("<<>>", maps())).toBe("<<>>");
	});
});

describe("resolveEntities (convenience wrapper)", () => {
	it("matches applyEntityResolution", () => {
		const text = "hey <@U1> in <#C1|general> <!here>";
		const m = maps({ U1: "Joel" }, { C1: "general" });
		expect(resolveEntities(text, m)).toBe(applyEntityResolution(text, m));
	});
});
