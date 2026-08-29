import { afterEach, describe, expect, it } from "vitest";
import {
  checkAddressRateLimit,
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
  it("keys on the resolved session user, wherever they call from", () => {
    expect(rateLimitKey("1.2.3.4", { userId: "user-1" })).toBe(
      rateLimitKey("5.6.7.8", { userId: "user-1" }),
    );
  });

  it("gives each user their own bucket, so one cannot spend another's", () => {
    expect(rateLimitKey("1.2.3.4", { userId: "user-1" })).not.toBe(
      rateLimitKey("1.2.3.4", { userId: "user-2" }),
    );
  });

  it("ignores every credential the caller presents", () => {
    const key = rateLimitKey("1.2.3.4", { userId: "user-1" });
    expect(key).toBe("user:user-1");
    expect(rateLimitKey("1.2.3.4", { userId: "user-1", jobToken: null })).toBe(key);
  });

  it("falls back to the caller IP when nobody was resolved", () => {
    expect(rateLimitKey("1.2.3.4")).toBe("ip:1.2.3.4");
    expect(rateLimitKey("1.2.3.4", { userId: null, jobToken: null })).toBe("ip:1.2.3.4");
  });

  it("still produces a key when the IP is unavailable", () => {
    expect(rateLimitKey("")).toBe("ip:unknown");
  });

  it("prefers a verified job token over the session user", () => {
    const key = rateLimitKey("127.0.0.1", { jobToken: "job-token", userId: "user-1" });
    expect(key.startsWith("job:")).toBe(true);
    expect(key).not.toContain("job-token");
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

  it("lifts the uploads ceiling for a caller the server resolved", () => {
    const uploads = "/api/v1/spaces/[spaceId]/uploads/[...path]";
    const anonymous = ruleForRoute(uploads, "GET");
    const signedIn = ruleForRoute(uploads, "GET", false, true);

    // A stranger enumerating a space stays bounded; a signed-in client reading
    // a file in ranges does not, since that is ordinary use and not abuse.
    expect(anonymous.max).toBe(300);
    expect(signedIn.max).toBeGreaterThan(anonymous.max);
    expect(signedIn.windowMs).toBe(anonymous.windowMs);
  });

  it("leaves a route without an authenticated ceiling unchanged", () => {
    const rebuild = "/api/v1/spaces/[spaceId]/search/rebuild";
    expect(ruleForRoute(rebuild, "POST", false, true)).toEqual(
      ruleForRoute(rebuild, "POST"),
    );
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

  it("blocks a user key as the 429 log line reports it", () => {
    process.env.VEKTOR_RATE_LIMIT_BLOCK = rateLimitKey("1.2.3.4", { userId: "abusive" });

    expect(
      checkRateLimit({ ...request, userId: "abusive" }, new RateLimiter()),
    ).toMatchObject({ allowed: false, blocked: true });
    // The same address, someone else: untouched.
    expect(
      checkRateLimit({ ...request, userId: "innocent" }, new RateLimiter()),
    ).toMatchObject({ allowed: true, blocked: false });
  });

  it("keeps one caller in one bucket however their credentials vary", () => {
    const limiter = new RateLimiter();
    const run = {
      ...request,
      pattern: "/api/v1/spaces/[spaceId]/jobs/run",
      method: "POST",
      userId: "user-1",
    };

    // The regression: an unvalidated credential used to key a window of its own.
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit({ ...run, jobToken: `junk-${i}` }, limiter)?.allowed).toBe(
        true,
      );
    }
    expect(checkRateLimit(run, limiter)).toMatchObject({ allowed: false });
  });

  it("counts an unauthenticated caller against their address", () => {
    const limiter = new RateLimiter();
    const completions = {
      ...request,
      pattern: "/api/v1/chat/completions",
      method: "POST",
    };

    for (let i = 0; i < 30; i++)
      expect(checkRateLimit(completions, limiter)?.allowed).toBe(true);
    expect(checkRateLimit(completions, limiter)).toMatchObject({ allowed: false });
    expect(checkRateLimit({ ...completions, ip: "5.5.5.5" }, limiter)).toMatchObject({
      allowed: true,
    });
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
    const other = { ...create, ip: "9.9.9.9", userId: "someone-else" };

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

describe("checkAddressRateLimit", () => {
  const request = { ip: "1.2.3.4" };

  it("keys on the address alone, ahead of any identity", () => {
    expect(checkAddressRateLimit(request, new RateLimiter())).toMatchObject({
      key: "ip:1.2.3.4",
      allowed: true,
    });
  });

  it("sheds a flooding address well above the per-caller ceiling", () => {
    process.env.VEKTOR_RATE_LIMIT_MAX = "10";
    const limiter = new RateLimiter();

    for (let i = 0; i < 100; i++)
      expect(checkAddressRateLimit(request, limiter)?.allowed).toBe(true);

    expect(checkAddressRateLimit(request, limiter)).toMatchObject({ allowed: false });
    expect(checkAddressRateLimit({ ip: "5.5.5.5" }, limiter)).toMatchObject({
      allowed: true,
    });
  });

  it("counts every route against the one address window", () => {
    process.env.VEKTOR_RATE_LIMIT_MAX = "10";
    const limiter = new RateLimiter();

    for (let i = 0; i < 100; i++) checkAddressRateLimit(request, limiter);
    expect(checkAddressRateLimit(request, limiter)).toMatchObject({ allowed: false });
  });

  it("honours the killswitch before the session lookup it guards", () => {
    process.env.VEKTOR_RATE_LIMIT_BLOCK = "ip:1.2.3.4";

    expect(checkAddressRateLimit(request, new RateLimiter())).toMatchObject({
      allowed: false,
      blocked: true,
    });
  });

  it("gives a verified job its own window, not the loopback one", () => {
    const spaceId = "space-1";
    const limiter = new RateLimiter();
    const job = {
      ip: "127.0.0.1",
      spaceId,
      jobToken: createJobToken(spaceId, String(Date.now()), "user-1"),
    };

    expect(checkAddressRateLimit(job, limiter)?.key.startsWith("job:")).toBe(true);
  });

  it("returns null when limiting is switched off", () => {
    process.env.VEKTOR_RATE_LIMIT = "0";
    expect(checkAddressRateLimit(request, new RateLimiter())).toBeNull();
  });
});
