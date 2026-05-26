/**
 * Pure lifecycle helpers — TTL expiry + idle reaping (the load-bearing v0.6.0
 * logic). These run with no bus and inject `now` for deterministic time.
 */

import { describe, expect, it } from "bun:test";
import {
	formatIdle,
	hasActiveSub,
	isExpired,
	isIdleExpired,
	pruneExpiredSubs,
	threadKey,
	ttlToExpiresAt,
} from "../lifecycle.ts";

const T0 = 1_000_000_000_000; // fixed reference "now"

describe("threadKey", () => {
	it("composes channel:ts", () => {
		expect(threadKey("C123", "1779.42")).toBe("C123:1779.42");
	});
});

describe("ttlToExpiresAt", () => {
	it("returns an absolute deadline for a positive ttl", () => {
		expect(ttlToExpiresAt(30, T0)).toBe(T0 + 30_000);
	});
	it("floors fractional seconds to whole ms", () => {
		expect(ttlToExpiresAt(1.5, T0)).toBe(T0 + 1500);
	});
	it("treats omitted / non-positive / non-number as session-lifetime (null)", () => {
		for (const bad of [undefined, null, 0, -5, NaN, Infinity, "30", {}]) {
			expect(ttlToExpiresAt(bad as unknown, T0)).toBeNull();
		}
	});
});

describe("isExpired", () => {
	it("null never expires", () => {
		expect(isExpired(null, T0)).toBe(false);
	});
	it("past deadline is expired, future is not, exact boundary counts as expired", () => {
		expect(isExpired(T0 - 1, T0)).toBe(true);
		expect(isExpired(T0 + 1, T0)).toBe(false);
		expect(isExpired(T0, T0)).toBe(true);
	});
});

describe("hasActiveSub", () => {
	const map = new Map<string, number | null>([
		["lifetime", null],
		["future", T0 + 10_000],
		["past", T0 - 10_000],
	]);
	it("missing key is not active", () => {
		expect(hasActiveSub(map, "nope", T0)).toBe(false);
	});
	it("session-lifetime sub is active", () => {
		expect(hasActiveSub(map, "lifetime", T0)).toBe(true);
	});
	it("future TTL is active, expired TTL is not", () => {
		expect(hasActiveSub(map, "future", T0)).toBe(true);
		expect(hasActiveSub(map, "past", T0)).toBe(false);
	});
});

describe("pruneExpiredSubs", () => {
	it("deletes only expired entries and returns the count, keeping lifetime + future", () => {
		const map = new Map<string, number | null>([
			["lifetime", null],
			["future", T0 + 5_000],
			["past1", T0 - 1],
			["past2", T0 - 99_999],
		]);
		const dropped = pruneExpiredSubs(map, T0);
		expect(dropped).toBe(2);
		expect([...map.keys()].sort()).toEqual(["future", "lifetime"]);
	});
	it("returns 0 and mutates nothing when none are expired", () => {
		const map = new Map<string, number | null>([["a", null], ["b", T0 + 1]]);
		expect(pruneExpiredSubs(map, T0)).toBe(0);
		expect(map.size).toBe(2);
	});
});

describe("isIdleExpired", () => {
	const idleWindow = 24 * 60 * 60 * 1000;
	it("idle beyond the window is reapable", () => {
		expect(isIdleExpired(T0 - idleWindow - 1, idleWindow, T0)).toBe(true);
	});
	it("exactly at the window is NOT yet reapable (strict >)", () => {
		expect(isIdleExpired(T0 - idleWindow, idleWindow, T0)).toBe(false);
	});
	it("fresh activity is not reapable", () => {
		expect(isIdleExpired(T0 - 1000, idleWindow, T0)).toBe(false);
	});
});

describe("formatIdle", () => {
	it("renders sub-hour as whole seconds", () => {
		expect(formatIdle(7_000)).toBe("7s");
	});
	it("renders hours-and-up with one decimal", () => {
		expect(formatIdle(26.3 * 3_600_000)).toBe("26.3h");
		expect(formatIdle(3_600_000)).toBe("1.0h");
	});
});
