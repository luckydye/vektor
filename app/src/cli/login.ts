import { randomBytes } from "node:crypto";
import { resolveHost } from "./resolve.ts";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
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
        return htmlResponse({
          title: "Login failed",
          message: "The CLI did not receive access. You can close this tab.",
          kind: "error",
        });
      }

      if (url.searchParams.get("state") !== state) {
        rejectCallback(new Error("State mismatch — possible CSRF, aborting"));
        return htmlResponse({
          title: "Invalid login state",
          message: "The CLI rejected this callback. You can close this tab.",
          kind: "error",
        });
      }

      const code = url.searchParams.get("code");
      if (!code) {
        rejectCallback(new Error("No code in callback"));
        return htmlResponse({
          title: "Missing login code",
          message: "The CLI could not complete the login. You can close this tab.",
          kind: "error",
        });
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
        return htmlResponse({
          title: "Logged in",
          message: "Vektor CLI is connected. You can close this tab.",
          kind: "success",
        });
      } catch (err) {
        rejectCallback(err instanceof Error ? err : new Error(String(err)));
        return htmlResponse({
          title: "Login failed",
          message: "The token exchange did not complete. You can close this tab.",
          kind: "error",
        });
      }
    },
  });

  const loginUrl = `${host}/api/v1/auth/cli?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  process.stderr.write(
    `Opening browser for login…\nIf it doesn't open, visit:\n  ${loginUrl}\n`,
  );
  openBrowser(loginUrl);

  const timeout = setTimeout(
    () => {
      rejectCallback(new Error("Login timed out after 5 minutes"));
    },
    5 * 60 * 1000,
  );

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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlResponse(options: {
  title: string;
  message: string;
  kind: "success" | "error";
}): Response {
  const icon =
    options.kind === "success"
      ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 17h.01M10.3 4.6 2.9 17.5A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.5L13.7 4.6a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vektor CLI</title>
    <style>
      :root {
        --primary-200: #c099cf;
        --primary-300: #b686c8;
        --primary-700: #78378f;
        --neutral-50: #f3f4f7;
        --neutral-100: #e2e5eb;
        --neutral-500: #647395;
        --neutral-900: #151820;
        --success: #15803d;
        --error: #b91c1c;
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 32px;
        background: #ffffff;
        color: var(--neutral-900);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(100%, 390px);
        text-align: center;
      }
      .logo {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 34px;
        color: var(--neutral-900);
        font-size: 15px;
        font-weight: 600;
      }
      .logo-mark {
        display: inline-flex;
        width: 32px;
        height: 32px;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        background: var(--primary-300);
      }
      .status-icon {
        display: inline-flex;
        width: 52px;
        height: 52px;
        align-items: center;
        justify-content: center;
        margin-bottom: 18px;
        border-radius: 999px;
        background: var(--neutral-50);
        color: ${options.kind === "success" ? "var(--success)" : "var(--error)"};
      }
      h1 {
        margin: 0;
        font-size: 1.6rem;
        line-height: 1.2;
        letter-spacing: 0;
      }
      p {
        margin: 8px 0 0;
        color: var(--neutral-500);
        font-size: 14px;
        line-height: 1.5;
      }
      .hint {
        margin-top: 22px;
        padding: 10px 12px;
        border: 1px solid var(--neutral-100);
        border-radius: 8px;
        background: var(--neutral-50);
        color: var(--neutral-500);
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="logo">
        <span class="logo-mark">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 2.5L8 13.5L14 2.5" stroke="white" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"></path>
          </svg>
        </span>
        <span>Vektor</span>
      </div>
      <div class="status-icon">${icon}</div>
      <h1>${escapeHtml(options.title)}</h1>
      <p>${escapeHtml(options.message)}</p>
      <div class="hint">Return to your terminal to continue.</div>
    </main>
  </body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html).toString(),
    },
  });
}
