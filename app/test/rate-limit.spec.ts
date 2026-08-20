import { afterEach, describe, expect, it } from "vitest";
import {
  checkRateLimit,
  DEFAULT_MAX,
  DEFAULT_WINDOW_SECONDS,
  RateLimiter,
  rateLimitKey,
  ruleForRoute,
} from "#api/rateLimit.ts";
import { createJobToken } from "#jobs/jobToken.ts";

/** A clock the test drives, so no spec waits on a real window. */
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

process.env.AUTH_SECRET ??= "rate-limit-test-secret-do-not-use-in-production";

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
    clock.advance(900); // 100ms left: rounding down would invite an instant retry.

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
    expect(rateLimitKey("Bearer at_secret", undefined, "1.2.3.4")).toBe(
      rateLimitKey("Bearer at_secret", undefined, "5.6.7.8"),
    );
  });

  it("separates distinct tokens", () => {
    expect(rateLimitKey("Bearer at_one", undefined, "1.2.3.4")).not.toBe(
      rateLimitKey("Bearer at_two", undefined, "1.2.3.4"),
    );
  });

  it("never puts the raw token in the key", () => {
    const key = rateLimitKey("Bearer at_secret", undefined, "1.2.3.4");
    expect(key.startsWith("token:")).toBe(true);
    expect(key).not.toContain("at_secret");
  });

  it("accepts the scheme case-insensitively", () => {
    expect(rateLimitKey("bearer at_secret", undefined, "1.2.3.4")).toBe(
      rateLimitKey("Bearer at_secret", undefined, "1.2.3.4"),
    );
  });

  it("falls back to the caller IP with neither token nor session", () => {
    expect(rateLimitKey(undefined, undefined, "1.2.3.4")).toBe("ip:1.2.3.4");
    // An empty bearer is not an identity, and must not share one bucket.
    expect(rateLimitKey("Bearer   ", undefined, "1.2.3.4")).toBe("ip:1.2.3.4");
  });

  it("still produces a key when the IP is unavailable", () => {
    expect(rateLimitKey(undefined, undefined, "")).toBe("ip:unknown");
  });

  it("gives each session its own bucket, so one user cannot spend another's", () => {
    const alice = rateLimitKey(undefined, "vektor.session_token=alice-token", "1.2.3.4");
    const bob = rateLimitKey(undefined, "vektor.session_token=bob-token", "1.2.3.4");
    expect(alice).not.toBe(bob);
    expect(alice.startsWith("session:")).toBe(true);
  });

  it("keys the same session identically from a different address", () => {
    expect(rateLimitKey(undefined, "vektor.session_token=alice", "1.2.3.4")).toBe(
      rateLimitKey(undefined, "vektor.session_token=alice", "5.6.7.8"),
    );
  });

  it("never puts the raw session token in the key", () => {
    const key = rateLimitKey(undefined, "vektor.session_token=s3cret", "1.2.3.4");
    expect(key).not.toContain("s3cret");
  });

  it("finds the session cookie among others, and under the Secure prefix", () => {
    const plain = rateLimitKey(undefined, "vektor.session_token=abc", "1.2.3.4");
    expect(
      rateLimitKey(undefined, "theme=dark; vektor.session_token=abc; tz=UTC", "1.2.3.4"),
    ).toBe(plain);
    expect(rateLimitKey(undefined, "__Secure-vektor.session_token=abc", "1.2.3.4")).toBe(
      plain,
    );
  });

  it("prefers the access token over the session cookie", () => {
    expect(
      rateLimitKey("Bearer at_secret", "vektor.session_token=alice", "1.2.3.4"),
    ).toBe(rateLimitKey("Bearer at_secret", undefined, "9.9.9.9"));
  });

  it("falls back to the IP when the session cookie carries no value", () => {
    expect(rateLimitKey(undefined, "vektor.session_token=", "1.2.3.4")).toBe(
      "ip:1.2.3.4",
    );
    expect(rateLimitKey(undefined, "theme=dark", "1.2.3.4")).toBe("ip:1.2.3.4");
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
    cookie: undefined,
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
    expect(limiter.size()).toBe(0); // blocked callers cost nothing to track

    expect(checkRateLimit({ ...request, ip: "5.5.5.5" }, limiter)).toMatchObject({
      allowed: true,
      blocked: false,
    });
  });

  it("blocks a token key by its hash, as the 429 log line reports it", () => {
    const key = rateLimitKey("Bearer at_abusive", undefined, "1.2.3.4");
    process.env.VEKTOR_RATE_LIMIT_BLOCK = key;

    expect(
      checkRateLimit(
        { ...request, authorization: "Bearer at_abusive" },
        new RateLimiter(),
      ),
    ).toMatchObject({ allowed: false, blocked: true });
  });

  it("does not spend a tight route ceiling on ordinary browsing", () => {
    const limiter = new RateLimiter();
    const run = {
      ...request,
      pattern: "/api/v1/spaces/[spaceId]/jobs/run",
      method: "POST",
    };

    // More ordinary requests than jobs/run allows, all well inside the default.
    for (let i = 0; i < 40; i++)
      expect(checkRateLimit(request, limiter)?.allowed).toBe(true);

    expect(checkRateLimit(run, limiter)).toMatchObject({ allowed: true, remaining: 29 });
  });

  it("counts space creation against one window for the whole instance", () => {
    const limiter = new RateLimiter();
    const create = { ...request, pattern: "/api/v1/spaces", method: "POST" };
    // A fresh account is a caller key away, so the ceiling has to be shared.
    const other = { ...create, ip: "9.9.9.9", cookie: "vektor.session_token=someone" };

    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(i % 2 ? create : other, limiter)?.allowed).toBe(true);
    }
    expect(checkRateLimit(create, limiter)).toMatchObject({ allowed: false });
    expect(checkRateLimit(other, limiter)).toMatchObject({ allowed: false });

    // Only that route: listing spaces is untouched by a full creation window.
    expect(checkRateLimit({ ...create, method: "GET" }, limiter)).toMatchObject({
      allowed: true,
    });
  });

  it("counts each rule against its own window", () => {
    const limiter = new RateLimiter();
    const completions = {
      ...request,
      pattern: "/api/v1/chat/completions",
      method: "POST",
    };
    const run = {
      ...request,
      pattern: "/api/v1/spaces/[spaceId]/jobs/run",
      method: "POST",
    };

    for (let i = 0; i < 30; i++)
      expect(checkRateLimit(completions, limiter)?.allowed).toBe(true);
    expect(checkRateLimit(completions, limiter)).toMatchObject({ allowed: false });

    expect(checkRateLimit(run, limiter)).toMatchObject({ allowed: true });
  });

  it("does not stretch other windows to a long rule's reset", () => {
    const clock = fixedClock();
    const limiter = new RateLimiter({ now: clock.now });
    const rebuild = {
      ...request,
      pattern: "/api/v1/spaces/[spaceId]/search/rebuild",
      method: "POST",
    };

    // The rebuild rule holds its window for an hour; the default one must still
    // reset a minute later.
    expect(checkRateLimit(rebuild, limiter)?.allowed).toBe(true);
    expect(checkRateLimit(request, limiter)).toMatchObject({
      allowed: true,
      remaining: 599,
    });
    clock.advance(61 * 1000);
    expect(checkRateLimit(request, limiter)).toMatchObject({
      allowed: true,
      remaining: 599,
    });
  });

  it("gives a verified job token a window of its own", () => {
    const limiter = new RateLimiter();
    const spaceId = "space-1";
    const run = {
      pattern: "/api/v1/spaces/[spaceId]/jobs/run",
      method: "POST",
      authorization: undefined,
      cookie: undefined,
      // Jobs reach the API over loopback, so every one of them shares this ip.
      ip: "127.0.0.1",
      spaceId,
    };
    const first = createJobToken(spaceId, String(Date.now()), "user-1");
    const second = createJobToken(spaceId, String(Date.now() - 1), "user-2");

    const decision = checkRateLimit({ ...run, jobToken: first }, limiter);
    expect(decision?.key.startsWith("job:")).toBe(true);

    // A second run, and an ordinary caller from the same address, are untouched.
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit({ ...run, jobToken: first }, limiter)?.allowed).toBe(true);
    }
    expect(checkRateLimit({ ...run, jobToken: second }, limiter)).toMatchObject({
      allowed: true,
      key: expect.not.stringMatching(decision?.key ?? ""),
    });
    expect(checkRateLimit(run, limiter)).toMatchObject({
      allowed: true,
      key: "ip:127.0.0.1",
    });
  });

  it("still bounds a job on the routes that cost the operator", () => {
    const limiter = new RateLimiter();
    const spaceId = "space-1";
    const completions = {
      pattern: "/api/v1/chat/completions",
      method: "POST",
      authorization: undefined,
      cookie: undefined,
      ip: "127.0.0.1",
      spaceId,
      jobToken: createJobToken(spaceId, String(Date.now()), "user-1"),
    };

    for (let i = 0; i < 30; i++)
      expect(checkRateLimit(completions, limiter)?.allowed).toBe(true);
    expect(checkRateLimit(completions, limiter)).toMatchObject({ allowed: false });
  });

  it("ignores a job token it did not sign", () => {
    const limiter = new RateLimiter();
    const forged = {
      ...request,
      spaceId: "space-1",
      jobToken: `${Date.now()}.-.${"0".repeat(64)}`,
    };

    // Falls back to the address, rather than minting a window per invention.
    expect(checkRateLimit(forged, limiter)).toMatchObject({ key: "ip:1.2.3.4" });
    expect(
      checkRateLimit(
        { ...forged, jobToken: createJobToken("other-space", String(Date.now()), null) },
        limiter,
      ),
    ).toMatchObject({ key: "ip:1.2.3.4" });
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
