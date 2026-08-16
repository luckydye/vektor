import { afterEach, describe, expect, it } from "vitest";
import {
  checkRateLimit,
  DEFAULT_MAX,
  DEFAULT_WINDOW_SECONDS,
  RateLimiter,
  rateLimitKey,
  ruleForRoute,
} from "#api/rateLimit.ts";

/** A limiter on a clock the test drives, so no spec waits on a real window. */
function fixedClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

const RULE = { max: 3, windowMs: 1000 };

const RATE_LIMIT_ENV = [
  "VEKTOR_RATE_LIMIT",
  "VEKTOR_RATE_LIMIT_MAX",
  "VEKTOR_RATE_LIMIT_WINDOW",
  "VEKTOR_RATE_LIMIT_BLOCK",
] as const;

afterEach(() => {
  for (const key of RATE_LIMIT_ENV) delete process.env[key];
});

describe("RateLimiter", () => {
  it("allows requests up to the limit and counts down remaining", () => {
    const clock = fixedClock();
    const limiter = new RateLimiter({ now: clock.now });

    expect(limiter.check("ip:a", RULE)).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.check("ip:a", RULE)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("ip:a", RULE)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("refuses the request past the limit with a positive Retry-After", () => {
    const clock = fixedClock();
    const limiter = new RateLimiter({ now: clock.now });

    for (let i = 0; i < RULE.max; i++) limiter.check("ip:a", RULE);

    const decision = limiter.check("ip:a", RULE);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("never reports Retry-After: 0 on a sub-second remainder", () => {
    const clock = fixedClock();
    const limiter = new RateLimiter({ now: clock.now });

    for (let i = 0; i < RULE.max; i++) limiter.check("ip:a", RULE);
    // 100ms left in the window: rounding down would invite an instant retry.
    clock.advance(900);

    expect(limiter.check("ip:a", RULE).retryAfterSeconds).toBe(1);
  });

  it("starts a fresh window once the old one elapses", () => {
    const clock = fixedClock();
    const limiter = new RateLimiter({ now: clock.now });

    for (let i = 0; i < RULE.max; i++) limiter.check("ip:a", RULE);
    expect(limiter.check("ip:a", RULE).allowed).toBe(false);

    clock.advance(RULE.windowMs);

    expect(limiter.check("ip:a", RULE)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("counts each key separately", () => {
    const clock = fixedClock();
    const limiter = new RateLimiter({ now: clock.now });

    for (let i = 0; i < RULE.max; i++) limiter.check("ip:a", RULE);

    expect(limiter.check("ip:a", RULE).allowed).toBe(false);
    expect(limiter.check("ip:b", RULE).allowed).toBe(true);
  });

  it("does not grow without bound under key-space flooding", () => {
    const clock = fixedClock();
    const limiter = new RateLimiter({ now: clock.now });

    for (let i = 0; i < 60_000; i++) {
      limiter.check(`ip:10.0.${Math.floor(i / 256)}.${i % 256}`, RULE);
    }

    expect(limiter.size()).toBeLessThanOrEqual(50_000);
  });
});

describe("rateLimitKey", () => {
  it("keys on the access token when one is presented", () => {
    expect(rateLimitKey("Bearer at_secret", "1.2.3.4")).toBe(
      rateLimitKey("Bearer at_secret", "5.6.7.8"),
    );
  });

  it("separates distinct tokens", () => {
    expect(rateLimitKey("Bearer at_one", "1.2.3.4")).not.toBe(
      rateLimitKey("Bearer at_two", "1.2.3.4"),
    );
  });

  it("never puts the raw token in the key", () => {
    const key = rateLimitKey("Bearer at_secret", "1.2.3.4");
    expect(key.startsWith("token:")).toBe(true);
    expect(key).not.toContain("at_secret");
  });

  it("accepts the scheme case-insensitively", () => {
    expect(rateLimitKey("bearer at_secret", "1.2.3.4")).toBe(
      rateLimitKey("Bearer at_secret", "1.2.3.4"),
    );
  });

  it("falls back to the caller IP without a bearer token", () => {
    expect(rateLimitKey(undefined, "1.2.3.4")).toBe("ip:1.2.3.4");
    // An empty bearer is not an identity; it must not collapse every such
    // caller onto one shared bucket.
    expect(rateLimitKey("Bearer   ", "1.2.3.4")).toBe("ip:1.2.3.4");
  });

  it("still produces a key when the IP is unavailable", () => {
    expect(rateLimitKey(undefined, "")).toBe("ip:unknown");
  });
});

describe("ruleForRoute", () => {
  it("gives the expensive routes a tighter bucket than the default", () => {
    const rebuild = ruleForRoute("/api/v1/spaces/[spaceId]/search/rebuild", "POST");
    expect(rebuild.max).toBeLessThan(DEFAULT_MAX);

    const completions = ruleForRoute("/api/v1/chat/completions", "POST");
    expect(completions.max).toBeLessThan(DEFAULT_MAX);
  });

  it("applies a method-scoped rule only to that method", () => {
    const pattern = "/api/v1/spaces/[spaceId]/workflows/runs";
    // Starting a run is the expensive half; listing runs is not.
    expect(ruleForRoute(pattern, "POST").max).toBeLessThan(DEFAULT_MAX);
    expect(ruleForRoute(pattern, "GET").max).toBe(DEFAULT_MAX);
  });

  it("falls back to the default rule for ordinary routes", () => {
    const rule = ruleForRoute("/api/v1/spaces/[spaceId]/documents", "GET");
    expect(rule).toEqual({
      max: DEFAULT_MAX,
      windowMs: DEFAULT_WINDOW_SECONDS * 1000,
    });
  });

  it("honours the configured default", () => {
    process.env.VEKTOR_RATE_LIMIT_MAX = "10";
    process.env.VEKTOR_RATE_LIMIT_WINDOW = "30";

    expect(ruleForRoute("/api/v1/spaces/[spaceId]/documents", "GET")).toEqual({
      max: 10,
      windowMs: 30_000,
    });
  });

  it("ignores a non-numeric or zero override rather than disabling the limit", () => {
    process.env.VEKTOR_RATE_LIMIT_MAX = "not-a-number";
    expect(ruleForRoute("/api/v1/users/me", "GET").max).toBe(DEFAULT_MAX);

    process.env.VEKTOR_RATE_LIMIT_MAX = "0";
    expect(ruleForRoute("/api/v1/users/me", "GET").max).toBe(DEFAULT_MAX);
  });
});

describe("checkRateLimit", () => {
  const request = {
    pattern: "/api/v1/spaces/[spaceId]/documents",
    method: "GET",
    authorization: undefined,
    ip: "1.2.3.4",
  };

  it("returns null when limiting is switched off", () => {
    process.env.VEKTOR_RATE_LIMIT = "0";
    expect(checkRateLimit(request, new RateLimiter())).toBeNull();

    process.env.VEKTOR_RATE_LIMIT = "false";
    expect(checkRateLimit(request, new RateLimiter())).toBeNull();
  });

  it("is on by default", () => {
    expect(checkRateLimit(request, new RateLimiter())).toMatchObject({
      allowed: true,
      key: "ip:1.2.3.4",
    });
  });

  it("refuses a key on the operator killswitch before counting it", () => {
    process.env.VEKTOR_RATE_LIMIT_BLOCK = "ip:1.2.3.4, ip:9.9.9.9";
    const limiter = new RateLimiter();

    const decision = checkRateLimit(request, limiter);
    expect(decision).toMatchObject({ allowed: false, blocked: true });
    expect(decision?.retryAfterSeconds).toBeGreaterThan(0);
    // Blocked callers cost nothing to track.
    expect(limiter.size()).toBe(0);

    expect(checkRateLimit({ ...request, ip: "5.5.5.5" }, limiter)).toMatchObject({
      allowed: true,
      blocked: false,
    });
  });

  it("blocks a token key by its hash, as the 429 log line reports it", () => {
    const key = rateLimitKey("Bearer at_abusive", "1.2.3.4");
    process.env.VEKTOR_RATE_LIMIT_BLOCK = key;

    expect(
      checkRateLimit(
        { ...request, authorization: "Bearer at_abusive" },
        new RateLimiter(),
      ),
    ).toMatchObject({ allowed: false, blocked: true });
  });

  it("marks over-limit callers as limited rather than blocked", () => {
    process.env.VEKTOR_RATE_LIMIT_MAX = "1";
    const limiter = new RateLimiter();

    expect(checkRateLimit(request, limiter)).toMatchObject({ allowed: true });
    expect(checkRateLimit(request, limiter)).toMatchObject({
      allowed: false,
      blocked: false,
    });
  });
});
