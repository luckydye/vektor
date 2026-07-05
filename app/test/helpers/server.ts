export type TestServerProcess = ReturnType<typeof Bun.spawn>;

export interface TestUserSession {
  userId: string;
  token: string;
  email: string;
  name: string;
}

const APP_DIR = new URL("../..", import.meta.url).pathname;

export function testBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function waitForServer(
  baseUrl: string,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/spaces`);
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

export function startTestServer(
  port: number,
  env: Record<string, string | undefined>,
): TestServerProcess {
  return Bun.spawn(["bun", "./src/server.ts", "--port", String(port)], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      VEKTOR_OTEL_ENABLED: "0",
      ...env,
    },
    stdout: "ignore",
    stderr: "ignore",
    cwd: APP_DIR,
  });
}

function jsonHeaders(options: RequestInit, sessionToken?: string): Headers {
  const headers = new Headers(options.headers);
  if (sessionToken) {
    headers.set("Cookie", `vektor.session_token=${sessionToken}`);
  }
  headers.set("Content-Type", "application/json");
  return headers;
}

export function createApiRequest(baseUrl: string) {
  return (path: string, options: RequestInit = {}): Promise<Response> => {
    return fetch(`${baseUrl}${path}`, { ...options, headers: jsonHeaders(options) });
  };
}

export function createSessionApiRequest(baseUrl: string) {
  return (
    path: string,
    sessionToken: string,
    options: RequestInit = {},
  ): Promise<Response> => {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: jsonHeaders(options, sessionToken),
    });
  };
}

export function createPageRequest(baseUrl: string) {
  return (path: string, sessionToken: string): Promise<Response> => {
    const headers = new Headers();
    if (sessionToken) {
      headers.set("Cookie", `vektor.session_token=${sessionToken}`);
    }
    return fetch(`${baseUrl}${path}`, { headers, redirect: "manual" });
  };
}

export function sessionTokenFromSignUp(response: Response, token: string): string {
  const match = response.headers
    .get("set-cookie")
    ?.match(/vektor\.session_token=([^;]+)/);
  return match?.[1] ?? `${token}.${Buffer.from(token).toString("base64")}`;
}

export async function createTestUser(
  baseUrl: string,
  name: string,
  emailPrefix = "test",
): Promise<TestUserSession> {
  const email = `${emailPrefix}-${Date.now()}-${Math.random()}@example.com`;
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "TestPassword123!", name }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create test user: ${response.statusText}`);
  }

  const data = await response.json();
  return {
    userId: data.user.id,
    token: sessionTokenFromSignUp(response, data.token),
    email,
    name: data.user.name,
  };
}
