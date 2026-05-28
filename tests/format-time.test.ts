/**
 * renderTimestamp turns a Slack epoch ts into an absolute, unambiguous string.
 * Assertions pin an explicit timeZone for determinism across CI zones, and
 * cover both DST sides (PDT/PST) plus weekday correctness.
 */

import { describe, expect, it } from "bun:test";
import { renderTimestamp } from "../format-time.ts";

describe("renderTimestamp", () => {
	it("renders the UTC epoch anchor", () => {
		// 1970-01-01 00:00:00 UTC was a Thursday.
		expect(renderTimestamp(0, "UTC")).toBe("1970-01-01 00:00 UTC (Thu)");
	});

	it("renders winter time as PST (UTC-8)", () => {
		// epoch 0 in LA is 1969-12-31 16:00 PST — a Wednesday.
		expect(renderTimestamp(0, "America/Los_Angeles")).toBe(
			"1969-12-31 16:00 PST (Wed)",
		);
	});

	it("renders summer time as PDT (UTC-7)", () => {
		// 2021-07-01 00:00:00 UTC → 2021-06-30 17:00 PDT (Wed).
		expect(renderTimestamp(1_625_097_600, "America/Los_Angeles")).toBe(
			"2021-06-30 17:00 PDT (Wed)",
		);
	});

	it("accepts the Slack '<seconds>.<micros>' string form and ignores micros", () => {
		// 2021-07-01 00:00:00 UTC was a Thursday.
		expect(renderTimestamp("1625097600.000100", "UTC")).toBe(
			"2021-07-01 00:00 UTC (Thu)",
		);
	});

	it("renders midnight as 00:00 (h23, never 24:00)", () => {
		expect(renderTimestamp(0, "UTC").includes("00:00")).toBe(true);
	});

	it("returns the raw input unchanged when unparseable (never throws)", () => {
		expect(renderTimestamp("not-a-number")).toBe("not-a-number");
		expect(renderTimestamp("")).toBe("");
	});
});
