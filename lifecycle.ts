// Pure subscription/session lifecycle helpers — TTL expiry and idle reaping.
//
// This is the load-bearing logic from v0.6.0 (per-sub TTLs + idle session
// reaper, motivated by DIG-203: Claude Code never sends MCP DELETE, so the
// transport's onsessionclosed never fires and sessions would leak forever).
// Kept pure and side-effect-light so it's unit-testable without booting the
// daemon — `now` is injectable everywhere to make time deterministic in tests.

export function threadKey(channel: string, ts: string): string {
	return `${channel}:${ts}`;
}

// Convert an optional `ttl_seconds` tool parameter into an absolute expiresAt
// timestamp. Returns null for session-lifetime (omitted, non-number, or
// non-positive). Absolute, not sliding — the deadline is fixed at subscribe
// time and does not extend on activity.
export function ttlToExpiresAt(
	ttlSeconds: unknown,
	now: number = Date.now(),
): number | null {
	if (
		typeof ttlSeconds !== "number" ||
		!Number.isFinite(ttlSeconds) ||
		ttlSeconds <= 0
	) {
		return null;
	}
	return now + Math.floor(ttlSeconds * 1000);
}

// A null expiresAt means session-lifetime (never expires on its own).
export function isExpired(
	expiresAt: number | null,
	now: number = Date.now(),
): boolean {
	return expiresAt !== null && expiresAt <= now;
}

// True if the sub key exists AND is not expired. Routing uses this to skip
// expired subs that the reaper hasn't swept yet.
export function hasActiveSub(
	map: Map<string, number | null>,
	key: string,
	now: number = Date.now(),
): boolean {
	if (!map.has(key)) return false;
	return !isExpired(map.get(key)!, now);
}

// Mutates `map`: deletes every expired entry, returns the count dropped.
// (Deleting during Map for...of is safe — already-visited/current keys are
// handled by the spec.)
export function pruneExpiredSubs(
	map: Map<string, number | null>,
	now: number = Date.now(),
): number {
	let dropped = 0;
	for (const [k, exp] of map) {
		if (isExpired(exp, now)) {
			map.delete(k);
			dropped++;
		}
	}
	return dropped;
}

// A session is idle-reapable when it hasn't been seen for longer than the
// configured window. lastSeen is bumped on every HTTP request routed to it.
export function isIdleExpired(
	lastSeen: number,
	idleReapMs: number,
	now: number = Date.now(),
): boolean {
	return now - lastSeen > idleReapMs;
}

// Human-readable idle duration for the reap log line: seconds under an hour,
// one-decimal hours above.
export function formatIdle(idleMs: number): string {
	return idleMs < 3_600_000
		? `${Math.floor(idleMs / 1000)}s`
		: `${(idleMs / 3_600_000).toFixed(1)}h`;
}
