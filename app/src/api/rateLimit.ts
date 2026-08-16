import { createHash } from "node:crypto";
import { config } from "#config";

/**
 * Fixed-window rate limiting for the API.
 *
 * A UI caller is paced by how fast a person can click; an API caller is not.
 * Several v1 routes do a large amount of work per request — rebuilding a
 * space's embeddings, proxying inference, fetching a remote URL — and nothing
 * upstream bounds how often they are called. This is the bound.
 *
 * In-memory and per-process, matching the single-binary deployment: there is no
 * shared store to coordinate with, and a limiter that needs one would be a new
 * external dependency. A restart therefore forgives outstanding windows, which
 * is the right trade for load-shedding (as opposed to quota accounting).
 */

export interface RateLimitRule {
  /** Requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests left in the current window. Zero once the limit is reached. */
  remaining: number;
  /** Seconds until the window resets. Only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
  /** True when the caller is on the operator's killswitch list, not merely over. */
  blocked: boolean;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Requests per window allowed by default, when no route rule is tighter. */
export const DEFAULT_MAX = 600;
/** Default window, in seconds. */
export const DEFAULT_WINDOW_SECONDS = 60;

/**
 * Beyond this many tracked keys the limiter sheds entries rather than grow.
 * Reached only under key-space flooding (a spoofed source per request), where
 * shedding is preferable to unbounded retention.
 */
const MAX_TRACKED_KEYS = 50_000;

/**
 * How many entries one eviction sheds. Shedding a batch rather than a single
 * entry is what keeps eviction amortized: the sweep it guards is O(size), so
 * running it per insert would make flooding the key space cost more than the
 * requests being bounded — an amplification vector inside the defence.
 */
const EVICTION_BATCH = 5_000;

interface RouteRule extends RateLimitRule {
  /** Bracket-parameter pattern, exactly as registered in `apiRoutes`. */
  pattern: string;
  /** Methods the tighter rule covers. All methods when omitted. */
  methods?: readonly string[];
}

/**
 * Routes whose per-request cost warrants a tighter bucket than the default.
 *
 * Ordered by how expensive one call is, not by how often it is called. The
 * ceilings sit well above ordinary product use — a canvas full of links bursts
 * link-previews on load, a document page pulls many uploads — so that reaching
 * one means something is wrong rather than merely busy.
 */
const ROUTE_RULES: readonly RouteRule[] = [
  // Re-embeds every document in the space: O(space) work behind a single call.
  {
    pattern: "/api/v1/spaces/[spaceId]/search/rebuild",
    max: 5,
    windowMs: 60 * MINUTE,
  },
  // Proxied inference, billed to whoever runs the instance.
  { pattern: "/api/v1/chat/completions", max: 30, windowMs: MINUTE },
  { pattern: "/api/v1/chat/acp", max: 30, windowMs: MINUTE },
  // Arbitrary user-defined execution.
  { pattern: "/api/v1/spaces/[spaceId]/jobs/run", max: 30, windowMs: MINUTE },
  {
    pattern: "/api/v1/spaces/[spaceId]/workflows/runs",
    methods: ["POST"],
    max: 30,
    windowMs: MINUTE,
  },
  // One outbound fetch per call.
  { pattern: "/api/v1/url-metadata", max: 120, windowMs: MINUTE },
  { pattern: "/api/v1/proxy-media", max: 120, windowMs: MINUTE },
  // Image decode/resize per request.
  {
    pattern: "/api/v1/spaces/[spaceId]/uploads/[...path]",
    max: 300,
    windowMs: MINUTE,
  },
];

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : fallback;
}

/** Rate limiting is on unless explicitly disabled. */
export function isRateLimitEnabled(): boolean {
  const raw = config().RATE_LIMIT;
  return !(raw === "0" || raw === "false");
}

/** The bucket applied to any route without a tighter rule of its own. */
export function defaultRateLimitRule(): RateLimitRule {
  return {
    max: positiveInt(config().RATE_LIMIT_MAX, DEFAULT_MAX),
    windowMs: positiveInt(config().RATE_LIMIT_WINDOW, DEFAULT_WINDOW_SECONDS) * SECOND,
  };
}

/** The rule governing one route, tightest match first. */
export function ruleForRoute(pattern: string, method: string): RateLimitRule {
  for (const rule of ROUTE_RULES) {
    if (rule.pattern !== pattern) continue;
    if (rule.methods && !rule.methods.includes(method)) continue;
    return { max: rule.max, windowMs: rule.windowMs };
  }
  return defaultRateLimitRule();
}

const BEARER_PREFIX = "bearer ";

/**
 * The identity a limit counts against: the access token when one is presented,
 * otherwise the caller's IP.
 *
 * Derived from headers alone so the check can run *before* the session lookup
 * and so bound that lookup too. The token is hashed rather than kept: these
 * keys sit in memory for the length of a window and are written to the log on a
 * 429, and neither is a place for a live credential.
 */
export function rateLimitKey(authorization: string | undefined, ip: string): string {
  if (authorization?.toLowerCase().startsWith(BEARER_PREFIX)) {
    const token = authorization.slice(BEARER_PREFIX.length).trim();
    if (token) {
      return `token:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
    }
  }
  return `ip:${ip || "unknown"}`;
}

/**
 * Keys the operator has switched off, from `VEKTOR_RATE_LIMIT_BLOCK`.
 *
 * The escape hatch for an integration that is hammering the instance right now:
 * the offending key is in the 429 log line, and naming it here sheds its load
 * without restarting or taking the API down for everyone else.
 */
export function blockedKeys(): ReadonlySet<string> {
  const raw = config().RATE_LIMIT_BLOCK;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

interface CountedWindow {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, CountedWindow>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Count one request against `key` and say whether it may proceed. */
  check(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = this.now();
    const current = this.windows.get(key);

    if (!current || current.resetAt <= now) {
      // Delete before re-adding so the key moves to the back of the Map's
      // insertion order — that ordering is what `evict` sheds by, and a key
      // refreshed in place would otherwise stay at the front forever.
      this.windows.delete(key);
      this.evict(now);
      this.windows.set(key, { count: 1, resetAt: now + rule.windowMs });
      return {
        allowed: true,
        remaining: Math.max(0, rule.max - 1),
        retryAfterSeconds: 0,
        blocked: false,
      };
    }

    if (current.count >= rule.max) {
      return {
        allowed: false,
        remaining: 0,
        // Always at least a second: a sub-second `Retry-After: 0` invites an
        // immediate retry, which is the behaviour being limited.
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / SECOND)),
        blocked: false,
      };
    }

    current.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, rule.max - current.count),
      retryAfterSeconds: 0,
      blocked: false,
    };
  }

  /** Tracked key count. Exposed for tests and diagnostics. */
  size(): number {
    return this.windows.size;
  }

  reset(): void {
    this.windows.clear();
  }

  private evict(now: number): void {
    if (this.windows.size < MAX_TRACKED_KEYS) return;

    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    if (this.windows.size < MAX_TRACKED_KEYS) return;

    // Every tracked window is still live, so age is the only signal left.
    const target = MAX_TRACKED_KEYS - EVICTION_BATCH;
    for (const key of this.windows.keys()) {
      if (this.windows.size <= target) break;
      this.windows.delete(key);
    }
  }
}

/** Process-wide limiter backing the API router. */
export const apiRateLimiter = new RateLimiter();

export interface RateLimitCheck extends RateLimitDecision {
  key: string;
}

/**
 * Apply the limit for one request. Returns `null` when limiting is disabled, so
 * the caller can skip the response headers entirely rather than report a
 * limit that is not being enforced.
 */
export function checkRateLimit(
  request: {
    pattern: string;
    method: string;
    authorization: string | undefined;
    ip: string;
  },
  limiter: RateLimiter = apiRateLimiter,
): RateLimitCheck | null {
  if (!isRateLimitEnabled()) return null;

  const key = rateLimitKey(request.authorization, request.ip);

  if (blockedKeys().has(key)) {
    return {
      key,
      allowed: false,
      remaining: 0,
      retryAfterSeconds: DEFAULT_WINDOW_SECONDS,
      blocked: true,
    };
  }

  const decision = limiter.check(key, ruleForRoute(request.pattern, request.method));
  return { key, ...decision };
}
