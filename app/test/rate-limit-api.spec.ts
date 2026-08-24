import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rateLimitKey } from "#api/rateLimit.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

/**
 * Cover for the limiter's wiring into `apiRouter`. The counting rules are
 * unit-tested in `rate-limit.spec.ts` against an injected clock.
 */

process.env.AUTH_SECRET ??= "rate-limit-test-secret-do-not-use-in-production";

const PORT = 7489;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

/** Low enough to reach in a test, high enough for the server's own readiness probe. */
const MAX = 20;

/** The killswitch names a derived key, so derive it as the router will. */
const BLOCKED_TOKEN = "at_blocked_integration_probe";
const ALLOWED_TOKEN = "at_allowed_integration_probe";
const BLOCKED_KEY = rateLimitKey(`Bearer ${BLOCKED_TOKEN}`, undefined, "127.0.0.1");

let serverProcess: TestServerProcess;

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
    VEKTOR_RATE_LIMIT: "1",
    VEKTOR_RATE_LIMIT_MAX: String(MAX),
    VEKTOR_RATE_LIMIT_WINDOW: "60",
    VEKTOR_RATE_LIMIT_BLOCK: BLOCKED_KEY,
    AUTH_SECRET: process.env.AUTH_SECRET ?? "rate-limit-test-secret",
  });
  await waitForServer(BASE_URL);
});

afterAll(() => {
  serverProcess?.kill();
});

function withToken(token: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/v1/spaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("API rate limiting", () => {
  it("advertises the remaining budget on a normal response", async () => {
    const response = await apiRequest("/api/v1/spaces");

    expect(response.status).toBe(200);
    const remaining = response.headers.get("X-Limit-Remaining");
    expect(remaining).not.toBeNull();
    expect(Number(remaining)).toBeGreaterThanOrEqual(0);
    expect(Number(remaining)).toBeLessThan(MAX);
  });

  it("refuses a killswitched key with its own message", async () => {
    const blocked = await withToken(BLOCKED_TOKEN);

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe(
      "API access temporarily disabled for this client",
    );
  });

  it("leaves every other token alone", async () => {
    const allowed = await withToken(ALLOWED_TOKEN);

    expect(allowed.status).not.toBe(429);
  });

  it("admits exactly the budget under a concurrent burst, never more", async () => {
    // A fresh token is a fresh key, so the arithmetic is exact.
    const token = "at_burst_probe";
    const burst = MAX * 3;

    const responses = await Promise.all(
      Array.from({ length: burst }, () => withToken(token)),
    );
    const statuses = responses.map((response) => response.status);
    const admitted = statuses.filter((status) => status !== 429);

    // Parallel arrivals must not over-admit: a counter read and written across
    // an await would let more than MAX through here.
    expect(admitted).toHaveLength(MAX);
    expect(statuses.filter((status) => status === 429)).toHaveLength(burst - MAX);

    // Each admitted request consumed exactly one slot; a lost update would not
    // produce MAX-1 … 0 with no repeats.
    const remaining = responses
      .filter((response) => response.status !== 429)
      .map((response) => Number(response.headers.get("X-Limit-Remaining")))
      .sort((a, b) => a - b);
    expect(remaining).toEqual(Array.from({ length: MAX }, (_, i) => i));
  });

  it("keeps concurrent callers on separate budgets", async () => {
    const [first, second] = await Promise.all([
      Promise.all(Array.from({ length: MAX }, () => withToken("at_burst_a"))),
      Promise.all(Array.from({ length: MAX }, () => withToken("at_burst_b"))),
    ]);

    // Interleaved in one event loop, but counted apart.
    expect(first.filter((r) => r.status === 429)).toHaveLength(0);
    expect(second.filter((r) => r.status === 429)).toHaveLength(0);
  });

  it("answers 429 with Retry-After once the window is spent", async () => {
    let limited: Response | undefined;

    // Earlier specs already spent part of the window, so drive well past MAX.
    for (let i = 0; i < MAX * 2; i++) {
      const response = await apiRequest("/api/v1/spaces");
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    if (!limited) throw new Error(`No 429 within ${MAX * 2} requests`);

    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(limited.headers.get("X-Limit-Remaining")).toBe("0");
    expect((await limited.json()).error).toBe("Too many requests");
  });
});
