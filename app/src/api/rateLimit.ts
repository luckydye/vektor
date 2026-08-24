import { createHash } from "node:crypto";
import { config } from "#config";
import { verifyJobToken } from "#jobs/jobToken.ts";

/**
 * Fixed-window API rate limiting, in-memory and per-process to match the
 * single-binary deployment. A restart forgives outstanding windows: this is
 * load-shedding, not quota accounting.
 */

export interface RateLimitRule {
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
  /** On the operator's killswitch list, as opposed to merely over the limit. */
  blocked: boolean;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const DEFAULT_MAX = 600;
export const DEFAULT_WINDOW_SECONDS = 60;

const MAX_TRACKED_KEYS = 50_000;

/**
 * Evicting a batch rather than one entry is what keeps eviction amortized: the
 * sweep it guards is O(size), so running it per insert would make flooding the
 * key space cost more than the requests being bounded.
 */
const EVICTION_BATCH = 5_000;

interface RouteRule extends RateLimitRule {
  /** Bracket-parameter pattern, exactly as registered in `apiRoutes`. */
  pattern: string;
  /** All methods when omitted. */
  methods?: readonly string[];
  /**
   * Whether a job's own call counts against this ceiling too. Set where the
   * cost lands on whoever runs the instance no matter who asked; elsewhere a
   * job falls back to the default rule, since a ceiling sized for one browser
   * would throttle a fan-out job against its own sub-jobs.
   */
  boundsJobs?: boolean;
  /**
   * Whether every caller counts against one shared window. Set where the route
   * costs the instance rather than the caller — the ceiling then bounds what the
   * host has to absorb, which is what a per-caller window cannot do once anyone
   * can sign up for another identity.
   */
  instance?: boolean;
}

export const SHARE_LINK_ROUTE_PATTERN = "/[spaceSlug]/s/[linkId]";

/**
 * Routes whose per-request cost warrants a tighter bucket than the default.
 * Ceilings sit well above ordinary use — a canvas bursts link-previews on load,
 * a document page pulls many uploads — so reaching one means something is wrong.
 */
const ROUTE_RULES: readonly RouteRule[] = [
  // Re-embeds every document in the space.
  {
    pattern: "/api/v1/spaces/[spaceId]/search/rebuild",
    max: 5,
    windowMs: 60 * MINUTE,
    boundsJobs: true,
  },
  // Proxied inference, billed to whoever runs the instance.
  { pattern: "/api/v1/chat/completions", max: 30, windowMs: MINUTE, boundsJobs: true },
  { pattern: "/api/v1/chat/acp", max: 30, windowMs: MINUTE, boundsJobs: true },
  // Allocates a database file of its own per call, so the ceiling is the
  // instance's: a per-caller one is spent by signing up again.
  {
    pattern: "/api/v1/spaces",
    methods: ["POST"],
    max: 10,
    windowMs: MINUTE,
    instance: true,
    boundsJobs: true,
  },
  // Arbitrary user-defined execution.
  { pattern: "/api/v1/spaces/[spaceId]/jobs/run", max: 30, windowMs: MINUTE },
  {
    pattern: "/api/v1/spaces/[spaceId]/workflows/runs",
    methods: ["POST"],
    max: 30,
    windowMs: MINUTE,
  },
  // Scans the documents of every space the caller can read.
  { pattern: "/api/v1/search", max: 60, windowMs: MINUTE },
  // One outbound fetch per call.
  { pattern: "/api/v1/url-metadata", max: 120, windowMs: MINUTE },
  { pattern: "/api/v1/proxy-media", max: 120, windowMs: MINUTE },
  // Image decode/resize per request.
  { pattern: "/api/v1/spaces/[spaceId]/uploads/[...path]", max: 300, windowMs: MINUTE },
  // Astro route; password verification makes this more expensive than a normal page.
  { pattern: SHARE_LINK_ROUTE_PATTERN, max: 120, windowMs: MINUTE },
];

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : fallback;
}

export function isRateLimitEnabled(): boolean {
  const raw = config().RATE_LIMIT;
  return !(raw === "0" || raw === "false");
}

export function defaultRateLimitRule(): RateLimitRule {
  return {
    max: positiveInt(config().RATE_LIMIT_MAX, DEFAULT_MAX),
    windowMs: positiveInt(config().RATE_LIMIT_WINDOW, DEFAULT_WINDOW_SECONDS) * SECOND,
  };
}

function matchRule(pattern: string, method: string, job: boolean): RouteRule | null {
  for (const rule of ROUTE_RULES) {
    if (rule.pattern !== pattern) continue;
    if (rule.methods && !rule.methods.includes(method)) continue;
    if (job && !rule.boundsJobs) return null;
    return rule;
  }
  return null;
}

export function ruleForRoute(
  pattern: string,
  method: string,
  job = false,
): RateLimitRule {
  const rule = matchRule(pattern, method, job);
  return rule ? { max: rule.max, windowMs: rule.windowMs } : defaultRateLimitRule();
}

/**
 * Which window a request counts against. A rule only counts its own route:
 * sharing one window per caller would spend a tight ceiling on ordinary
 * browsing, and let a long window hold every later request to that ceiling.
 *
 * `callerKey` is dropped for an instance-scoped rule, which is the whole point
 * of one: every caller lands in the same window.
 */
export function windowKey(
  callerKey: string,
  pattern: string,
  method: string,
  job = false,
): string {
  const rule = matchRule(pattern, method, job);
  if (!rule) return `${callerKey}|default`;

  const bucket = `${rule.pattern}|${rule.methods?.join(",") ?? "*"}`;
  return rule.instance ? `instance|${bucket}` : `${callerKey}|${bucket}`;
}

const BEARER_PREFIX = "bearer ";

function sessionCookieValue(cookie: string | undefined): string | null {
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name.endsWith("session_token")) continue;
    const value = part.slice(separator + 1).trim();
    if (value) return value;
  }
  return null;
}

/**
 * The access token when one is presented, otherwise the caller's IP. Derived
 * from headers alone so the check can run before the session lookup and bound
 * it too; the token is hashed because these keys reach the log on a 429.
 *
 * `jobToken` must already be verified: it precedes the other credentials
 * because a job's call to this instance's own API carries neither a session
 * nor a bearer, and would otherwise land on the loopback address every job in
 * the process shares.
 */
export function rateLimitKey(
  authorization: string | undefined,
  cookie: string | undefined,
  ip: string,
  jobToken?: string | null,
): string {
  if (jobToken) return `job:${shortHash(jobToken)}`;
  if (authorization?.toLowerCase().startsWith(BEARER_PREFIX)) {
    const token = authorization.slice(BEARER_PREFIX.length).trim();
    if (token) return `token:${shortHash(token)}`;
  }
  const session = sessionCookieValue(cookie);
  if (session) return `session:${shortHash(session)}`;
  return `ip:${ip || "unknown"}`;
}

/**
 * A job token earns its own window only once the HMAC checks out — taking the
 * header at face value would hand any caller an unlimited supply of fresh
 * windows, one per invented token.
 */
function verifiedJobToken(
  token: string | undefined,
  spaceId: string | undefined,
): string | null {
  if (!token || !spaceId) return null;
  try {
    return verifyJobToken(token, spaceId) ? token : null;
  } catch {
    // Signing throws when AUTH_SECRET is unset, and an instance that cannot
    // sign a token cannot have issued this one.
    return null;
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Keys the operator has switched off, from `VEKTOR_RATE_LIMIT_BLOCK`. */
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

  check(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = this.now();
    const current = this.windows.get(key);

    if (!current || current.resetAt <= now) {
      // Delete before re-adding so the key moves to the back of the insertion
      // order `evict` sheds by; refreshed in place it would stay at the front.
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
        // At least a second: `Retry-After: 0` invites the immediate retry this
        // is meant to stop.
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

    // Every window is still live, so age is the only signal left.
    const target = MAX_TRACKED_KEYS - EVICTION_BATCH;
    for (const key of this.windows.keys()) {
      if (this.windows.size <= target) break;
      this.windows.delete(key);
    }
  }
}

export const apiRateLimiter = new RateLimiter();

export interface RateLimitCheck extends RateLimitDecision {
  key: string;
}

/** Null when limiting is disabled, so callers skip the headers entirely. */
export function checkRateLimit(
  request: {
    pattern: string;
    method: string;
    authorization: string | undefined;
    cookie: string | undefined;
    ip: string;
    jobToken?: string | undefined;
    /** Scope the job token is checked against, from the header or the route. */
    spaceId?: string | undefined;
  },
  limiter: RateLimiter = apiRateLimiter,
): RateLimitCheck | null {
  if (!isRateLimitEnabled()) return null;

  const jobToken = verifiedJobToken(request.jobToken, request.spaceId);
  const key = rateLimitKey(request.authorization, request.cookie, request.ip, jobToken);

  if (blockedKeys().has(key)) {
    return {
      key,
      allowed: false,
      remaining: 0,
      retryAfterSeconds: DEFAULT_WINDOW_SECONDS,
      blocked: true,
    };
  }

  const job = jobToken !== null;
  const decision = limiter.check(
    windowKey(key, request.pattern, request.method, job),
    ruleForRoute(request.pattern, request.method, job),
  );
  return { key, ...decision };
}
