/**
 * classifyError buckets tool failures so a consuming agent can tell "retry"
 * from "stop". These feed it objects shaped like @slack/web-api's
 * WebAPICallError (the real thing the dispatch catches at runtime).
 */

import { describe, expect, it } from "bun:test";
import { classifyError } from "../classify-error.ts";

// Minimal stand-ins for @slack/web-api error shapes.
function platformError(slackError: string) {
	return Object.assign(new Error(`An API error occurred: ${slackError}`), {
		code: "slack_webapi_platform_error",
		data: { ok: false, error: slackError },
	});
}
function requestError(originalCode: string) {
	return Object.assign(new Error("A request error occurred: " + originalCode), {
		code: "slack_webapi_request_error",
		original: Object.assign(new Error(originalCode), { code: originalCode }),
	});
}
function httpError(statusCode: number) {
	return Object.assign(new Error(`An HTTP protocol error occurred: ${statusCode}`), {
		code: "slack_webapi_http_error",
		statusCode,
	});
}
function rateLimitedError(retryAfter?: number) {
	return Object.assign(new Error("A rate-limiting error occurred"), {
		code: "slack_webapi_rate_limited_error",
		retryAfter,
	});
}

describe("classifyError", () => {
	it("flags auth failures as non-retryable", () => {
		for (const code of ["invalid_auth", "token_revoked", "missing_scope", "account_inactive"]) {
			const r = classifyError(platformError(code));
			expect(r.category).toBe("auth");
			expect(r.message).toContain(code);
			expect(r.message).toMatch(/NOT resolve on retry/i);
		}
	});

	it("flags network request errors as unreachable", () => {
		const r = classifyError(requestError("ENOTFOUND"));
		expect(r.category).toBe("unreachable");
		expect(r.message).toContain("ENOTFOUND");
		expect(r.message).toMatch(/retry/i);
	});

	it("treats HTTP 5xx as unreachable but 4xx as not", () => {
		expect(classifyError(httpError(503)).category).toBe("unreachable");
		// A 429 without the rate-limit code / errno is unknown, not unreachable.
		expect(classifyError(httpError(429)).category).toBe("unknown");
	});

	it("flags rate limiting with the retry-after hint", () => {
		const r = classifyError(rateLimitedError(30));
		expect(r.category).toBe("rate_limited");
		expect(r.message).toContain("30s");
	});

	it("rate limit without retryAfter still classifies", () => {
		const r = classifyError(rateLimitedError(undefined));
		expect(r.category).toBe("rate_limited");
		expect(r.message).toMatch(/few seconds/i);
	});

	it("passes ordinary API errors through as the api category", () => {
		const r = classifyError(platformError("channel_not_found"));
		expect(r.category).toBe("api");
		expect(r.message).toContain("channel_not_found");
	});

	it("catches bare fetch failures by message", () => {
		const r = classifyError(new Error("fetch failed"));
		expect(r.category).toBe("unreachable");
	});

	it("catches socket errnos surfaced via cause", () => {
		const r = classifyError(Object.assign(new Error("boom"), { cause: { code: "ECONNREFUSED" } }));
		expect(r.category).toBe("unreachable");
	});

	it("falls back to unknown for plain handler validation throws", () => {
		const r = classifyError(new Error("post_message requires either `blocks` or `text`."));
		expect(r.category).toBe("unknown");
		expect(r.message).toContain("post_message requires");
	});
});
