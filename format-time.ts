// Render a Slack epoch timestamp into an absolute, unambiguous string for the
// consuming agent — so it never has to convert epoch→date in its head (a known
// error vector: a raw `ts` once got misread as "today" when it was the prior
// day, see DIG-242).
//
// Absolute facts only: date, 24h time, timezone abbreviation, day-of-week.
// NO relative markers ("today"/"yesterday") — relative-to-now is a function of
// the *agent's* sense of the current date (a separate mechanism), not the
// message's intrinsic time. Two systems both claiming authority over "now" is
// the wrong split.
//
// Slack ts is "<seconds>.<microseconds>" (e.g. "1779897289.590119"). We render
// at minute resolution, so the microseconds are ignored.
//
// `timeZone` defaults to the daemon's system zone (correct for the operator).
// Tests pass it explicitly for determinism across CI zones.

export function renderTimestamp(ts: string | number, timeZone?: string): string {
	const seconds = typeof ts === "number" ? ts : Number.parseFloat(ts);
	if (!Number.isFinite(seconds)) return String(ts); // unparseable → return raw, never throw
	const d = new Date(seconds * 1000);
	if (Number.isNaN(d.getTime())) return String(ts);

	const fmt = new Intl.DateTimeFormat("en-US", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		weekday: "short",
		timeZoneName: "short",
		...(timeZone ? { timeZone } : {}),
	});

	const p: Record<string, string> = {};
	for (const part of fmt.formatToParts(d)) p[part.type] = part.value;

	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName} (${p.weekday})`;
}
