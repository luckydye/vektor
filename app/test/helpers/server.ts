export type TestServerProcess = ReturnType<typeof Bun.spawn>;

export interface TestUserSession {
  userId: string;
  token: string;
  email: string;
  name: string;
}

/**
 * Where to spawn the server from.
 *
 * `import.meta.url` is not a `file:` URL inside a vitest-transformed module, so
 * deriving the path from it silently yields the wrong directory — the server
 * then starts somewhere without `dist/client` and answers every frontend route
 * with a 404 while the API keeps working. `process.cwd()` is the runner root,
 * which is `app/`.
 */
const APP_DIR = process.cwd();

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

/**
 * How to launch the server under test.
 *
 * Jobs and workflows load a native addon and execute inside it, which behaves
 * differently in a compiled binary — where the addon and its loader are embedded
 * in `$bunfs` — than under `bun src/server.ts`. Setting `VEKTOR_TEST_BINARY` to a
 * compiled `./vektor` runs the specs against the shipped form instead.
 */
export function testServerCommand(port: number): string[] {
  const binary = process.env.VEKTOR_TEST_BINARY;
  return binary
    ? [binary, "serve", "--port", String(port)]
    : ["bun", "./src/server.ts", "--port", String(port)];
}

/**
 * Vite's injected env vars, which must not reach the server.
 *
 * The runner puts these in `process.env`, and spreading it into the child hands
 * the server `DEV=1` — Bun reads that into `import.meta.env.DEV`, so
 * `src/server.ts` takes its dev branch and boots `astro dev` instead of loading
 * the built SSR handler. The API keeps answering and every frontend route
 * returns 404, which reads like an ACL bug rather than a runner artefact.
 */
const VITE_INJECTED = new Set([
  "BASE_URL",
  "DEV",
  "MODE",
  "PROD",
  "SSR",
  "TEST",
  "VITEST",
]);

function childEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !VITE_INJECTED.has(key) && !key.startsWith("VITEST_"),
    ),
  );
}

export function startTestServer(
  port: number,
  env: Record<string, string | undefined>,
): TestServerProcess {
  // Set VEKTOR_TEST_SERVER_LOG to a path to keep the server's output; without it
  // the specs stay quiet.
  const logPath = process.env.VEKTOR_TEST_SERVER_LOG;
  const sink = logPath ? Bun.file(logPath).writer() : undefined;

  const child = Bun.spawn(testServerCommand(port), {
    env: {
      ...childEnv(),
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      // Every spec drives the server from 127.0.0.1, so they all share one rate
      // limit key and would spend each other's budget. Off by default here and
      // switched back on by the specs that are actually about it
      // (`rate-limit-api.spec.ts`), rather than left on to flake the rest.
      VEKTOR_RATE_LIMIT: "0",
      ...env,
    },
    stdout: sink ? "pipe" : "ignore",
    stderr: sink ? "pipe" : "ignore",
    cwd: APP_DIR,
  });

  if (sink) {
    for (const stream of [child.stdout, child.stderr]) {
      void (async () => {
        for await (const chunk of stream as ReadableStream<Uint8Array>) {
          sink.write(chunk);
          sink.flush();
        }
      })();
    }
  }

  return child;
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
