import { randomBytes } from "node:crypto";
import { resolveHost } from "./resolve.ts";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "cmd" :
    "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
}

export async function commandLogin(): Promise<void> {
  const host = resolveHost().replace(/\/$/, "");

  // Random port in a range unlikely to clash with common dev servers.
  const port = 51000 + Math.floor(Math.random() * 8999);
  const state = randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${port}/callback`;

  let resolveCallback: (result: { token: string; spaceId: string }) => void;
  let rejectCallback: (err: Error) => void;
  const callbackPromise = new Promise<{ token: string; spaceId: string }>((res, rej) => {
    resolveCallback = res;
    rejectCallback = rej;
  });

  const server = Bun.serve({
    port,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 });
      }

      const error = url.searchParams.get("error");
      if (error) {
        rejectCallback(new Error(`Login failed: ${error}`));
        return htmlResponse("Login failed. You can close this tab.");
      }

      if (url.searchParams.get("state") !== state) {
        rejectCallback(new Error("State mismatch — possible CSRF, aborting"));
        return htmlResponse("Invalid state. You can close this tab.");
      }

      const code = url.searchParams.get("code");
      if (!code) {
        rejectCallback(new Error("No code in callback"));
        return htmlResponse("Missing code. You can close this tab.");
      }

      try {
        const res = await fetch(`${host}/api/v1/auth/cli/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => String(res.status));
          throw new Error(`Token exchange failed (${res.status}): ${text}`);
        }
        const data = (await res.json()) as { token: string; spaceId: string };
        resolveCallback(data);
        return htmlResponse("Logged in. You can close this tab.");
      } catch (err) {
        rejectCallback(err instanceof Error ? err : new Error(String(err)));
        return htmlResponse("Login failed. You can close this tab.");
      }
    },
  });

  const loginUrl =
    `${host}/api/v1/auth/cli?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  process.stderr.write(`Opening browser for login…\nIf it doesn't open, visit:\n  ${loginUrl}\n`);
  openBrowser(loginUrl);

  const timeout = setTimeout(() => {
    rejectCallback(new Error("Login timed out after 5 minutes"));
  }, 5 * 60 * 1000);

  try {
    const { token, spaceId } = await callbackPromise;

    process.stdout.write(
      [
        "",
        "Logged in. Add to your shell profile:",
        "",
        `  export VEKTOR_HOST=${host}`,
        `  export VEKTOR_SPACE_ID=${spaceId}`,
        `  export VEKTOR_ACCESS_TOKEN=${token}`,
        "",
        "Or for just this session:",
        "",
        `  export VEKTOR_ACCESS_TOKEN=${token}`,
        "",
      ].join("\n"),
    );
  } finally {
    clearTimeout(timeout);
    server.stop();
  }
}

function htmlResponse(message: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Vektor CLI</title></head><body><p>${message}</p></body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}
