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
 * End-to-end cover for the limiter's wiring: that `apiRouter` actually consults
 * it, that a refusal is a 429 carrying `Retry-After`, and that the killswitch
 * reaches a real request. The counting rules themselves are unit-tested in
 * `rate-limit.spec.ts` against an injected clock.
 */

process.env.AUTH_SECRET ??= "rate-limit-test-secret-do-not-use-in-production";

const PORT = 7489;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

/** Low enough to reach in a test, high enough for the server's own readiness probe. */
const MAX = 20;

/**
 * The killswitch names a *derived* key, never a credential — so the spec has to
 * derive it the same way the router will, from the token it is about to send.
 */
const BLOCKED_TOKEN = "at_blocked_integration_probe";
const ALLOWED_TOKEN = "at_allowed_integration_probe";
const BLOCKED_KEY = rateLimitKey(`Bearer ${BLOCKED_TOKEN}`, "127.0.0.1");

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
    // Token callers are keyed by token, so this one keeps its own budget even
    // once the shared 127.0.0.1 bucket is spent.
    const allowed = await withToken(ALLOWED_TOKEN);

    expect(allowed.status).not.toBe(429);
  });

  it("answers 429 with Retry-After once the window is spent", async () => {
    let limited: Response | undefined;

    // The readiness probe and the spec above already spent part of the window,
    // so drive well past MAX rather than exactly to it.
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
