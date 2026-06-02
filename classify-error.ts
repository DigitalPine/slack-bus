// Classify a thrown error from a tool handler into an actionable category.
// The consuming agent gets the returned message — it needs to tell "transient
// — retry" apart from "broken — stop" rather than receiving an opaque stack.
//
// We duck-type on @slack/web-api's WebAPICallError shape (err.code string +
// err.data.error) instead of importing the ErrorCode enum, so a web-api
// version bump can't silently break classification.
//
// Scope: a dead MCP *transport* (Claude Code can't reach the daemon) never
// reaches here — it surfaces client-side as an "unhealthy" server. This covers
// only failures of a tool that actually ran: the daemon-to-Slack-cloud leg.

export type ErrorCategory =
	| "unreachable"
	| "rate_limited"
	| "auth"
	| "plan"
	| "api"
	| "unknown";

// Slack platform errors that will not resolve on retry — the token/scopes need
// human attention, so an agent should stop rather than loop.
const SLACK_AUTH_ERRORS = new Set([
	"invalid_auth",
	"not_authed",
	"account_inactive",
	"token_revoked",
	"token_expired",
	"no_permission",
	"missing_scope",
	"ekm_access_denied",
]);

// OS-level socket errnos that mean "couldn't reach the host".
const NETWORK_ERRNOS = new Set([
	"ENOTFOUND",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ECONNRESET",
	"EAI_AGAIN",
	"EPIPE",
	"ENETUNREACH",
	"EHOSTUNREACH",
]);

export function classifyError(err: unknown): {
	category: ErrorCategory;
	message: string;
} {
	const e = err as any;
	const raw = err instanceof Error ? err.message : String(err);
	const code: string = typeof e?.code === "string" ? e.code : "";
	const slackError: string =
		typeof e?.data?.error === "string" ? e.data.error : "";

	// Rate limit — Slack tells us exactly how long to back off.
	if (
		code === "slack_webapi_rate_limited_error" ||
		slackError === "ratelimited" ||
		slackError === "rate_limited"
	) {
		const retryAfter = Number(e?.retryAfter);
		const wait =
			Number.isFinite(retryAfter) && retryAfter > 0
				? `${retryAfter}s`
				: "a few seconds";
		return {
			category: "rate_limited",
			message: `Slack rate-limited this request. Retry after ${wait}.`,
		};
	}

	// Auth / scope — retrying won't help.
	if (SLACK_AUTH_ERRORS.has(slackError)) {
		return {
			category: "auth",
			message: `Slack auth failed (${slackError}): the slack-bus daemon's bot token is invalid, revoked, expired, or missing a scope. This will NOT resolve on retry — the daemon's token/scopes need attention. Do not loop.`,
		};
	}

	// Connectivity — the daemon couldn't reach Slack's cloud. Distinct from the
	// MCP transport being down (which never reaches here).
	const errno: string =
		typeof e?.original?.code === "string"
			? e.original.code
			: typeof e?.cause?.code === "string"
				? e.cause.code
				: "";
	const isRequestError = code === "slack_webapi_request_error";
	const isHttp5xx =
		code === "slack_webapi_http_error" && Number(e?.statusCode) >= 500;
	const looksNetwork =
		NETWORK_ERRNOS.has(code) ||
		NETWORK_ERRNOS.has(errno) ||
		/fetch failed|network|socket hang ?up|ENOTFOUND|ETIMEDOUT/i.test(raw);
	if (isRequestError || isHttp5xx || looksNetwork) {
		const detail =
			errno || (Number(e?.statusCode) ? `HTTP ${e.statusCode}` : raw);
		return {
			category: "unreachable",
			message: `Slack unreachable: the slack-bus daemon could not reach Slack's API (${detail}). The daemon and your MCP connection are healthy — this is a network/DNS problem between the daemon and api.slack.com. Safe to retry shortly; if it persists, the machine likely lost connectivity.`,
		};
	}

	// Workspace-plan restriction — the action is valid but this workspace's Slack
	// tier doesn't allow it. Retrying won't help; the agent needs to know it hit a
	// plan ceiling (not a bug in its request) and what the workaround is. The
	// canvas free-tier case is the confirmed one (verified 2026-06-01 against the
	// Digital Pine free workspace); the broader family is matched defensively.
	if (slackError === "free_teams_cannot_create_non_tabbed_canvases") {
		return {
			category: "plan",
			message:
				"Slack plan limit: this workspace is on the FREE tier, which can't create standalone (non-tabbed) canvases. This is not a request error and won't resolve on retry. Fix: pass a channel_id to create_canvas (attaches the canvas as a channel tab) or use create_channel_canvas. Standalone canvases require a paid workspace.",
		};
	}
	// Distinct from a tier ceiling: the channel already has its (one, on free) native
	// canvas, so conversations.canvases.create can't make another. The fix is to edit
	// the existing one or add a separate tabbed canvas — not to upgrade. Surface that
	// recovery path rather than a misleading "your plan can't do this".
	if (slackError === "free_team_canvas_tab_already_exists") {
		return {
			category: "api",
			message:
				"This channel already has a canvas (free workspaces allow one native channel canvas). Won't resolve on retry. To UPDATE it, edit the existing canvas with edit_canvas (find its file_id via the channel's canvas tab). To add a SEPARATE canvas, call create_canvas with a channel_id — that adds a tabbed canvas alongside.",
		};
	}
	// Narrow, genuinely tier-ceiling codes only — NOT a broad `free_team` match,
	// which also catches state conditions like *_already_exists (handled above).
	if (
		/paid_only|paid_teams_only|team_not_on_paid|not_allowed_on_free|plan_(?:upgrade|restricted)/i.test(
			slackError,
		)
	) {
		return {
			category: "plan",
			message: `Slack plan limit (${slackError}): this action isn't available on the workspace's current Slack tier. This won't resolve on retry — it needs a plan with the feature, or a different approach that works on the current tier.`,
		};
	}

	// Ordinary Slack API error (channel_not_found, etc.) — the code is already
	// actionable, so surface it cleanly.
	if (slackError) {
		return { category: "api", message: `Slack API error: ${slackError}` };
	}

	// Validation throw from a handler, or anything we don't recognize.
	return { category: "unknown", message: raw };
}
