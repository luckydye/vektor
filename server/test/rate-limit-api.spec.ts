import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const BLOCKED_IP = "9.9.9.9";

let serverProcess: TestServerProcess;

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
    VEKTOR_RATE_LIMIT: "1",
    VEKTOR_RATE_LIMIT_MAX: String(MAX),
    VEKTOR_RATE_LIMIT_WINDOW: "60",
    VEKTOR_RATE_LIMIT_BLOCK: `ip:${BLOCKED_IP}`,
    VEKTOR_TRUST_PROXY: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "rate-limit-test-secret",
  });
  await waitForServer(BASE_URL);
});

afterAll(() => {
  serverProcess?.kill();
});

function request(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/v1/spaces`, { headers });
}

async function remainingBudget(): Promise<number> {
  const response = await request();
  return Number(response.headers.get("X-Limit-Remaining"));
}

describe("API rate limiting", () => {
  it("refuses a killswitched key with its own message", async () => {
    const blocked = await request({ "X-Forwarded-For": BLOCKED_IP });

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe(
      "API access temporarily disabled for this client",
    );
  });

  it("leaves every other address alone", async () => {
    expect((await request({ "X-Forwarded-For": "9.9.9.8" })).status).not.toBe(429);
  });

  it("advertises the remaining budget on a normal response", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    const remaining = Number(response.headers.get("X-Limit-Remaining"));
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThan(MAX);
  });

  it("counts one caller in one bucket however their credentials vary", async () => {
    const budget = await remainingBudget();
    const burst = budget + MAX;

    // The bypass this guards: a bearer nobody validated used to key its own
    // window, so every ceiling was one header away from advisory.
    const responses = await Promise.all(
      Array.from({ length: burst }, (_, i) =>
        request({
          Authorization: `Bearer junk-${i}`,
          Cookie: `junk-${i}.session_token=junk-${i}`,
        }),
      ),
    );
    const statuses = responses.map((response) => response.status);
    const admitted = statuses.filter((status) => status !== 429);

    expect(admitted).toHaveLength(budget);
    expect(statuses.filter((status) => status === 429)).toHaveLength(burst - budget);

    // Each admitted request consumed exactly one slot; a lost update across an
    // await would not produce budget-1 … 0 with no repeats.
    const remaining = responses
      .filter((response) => response.status !== 429)
      .map((response) => Number(response.headers.get("X-Limit-Remaining")))
      .sort((a, b) => a - b);
    expect(remaining).toEqual(Array.from({ length: budget }, (_, i) => i));
  });

  it("answers 429 with Retry-After once the window is spent", async () => {
    const limited = await apiRequest("/api/v1/spaces");

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(limited.headers.get("X-Limit-Remaining")).toBe("0");
    expect((await limited.json()).error).toBe("Too many requests");
  });
});
