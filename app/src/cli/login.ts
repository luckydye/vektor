import { randomBytes } from "node:crypto";
import { config } from "#config";
import { escapeHtml } from "#utils/html.ts";
import { apiFetch } from "./request.ts";
import {
  clearStoredConfig,
  DEFAULT_HOST,
  resolveHost,
  writeSshLogin,
  writeStoredConfig,
} from "./resolve.ts";
import { discoverSshSigners, type SshSigner } from "./sshAgent.ts";

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

interface CliTokenResult {
  token: string;
  spaceId: string;
  permission?: string;
  expiresAt?: string;
}

/** The approval page's error codes, in terms the user can act on. */
const LOGIN_ERRORS: Record<string, string> = {
  access_denied: "Access was canceled in the browser.",
  no_spaces: "You have no spaces yet. Create one in the web app, then log in again.",
  no_space_roles:
    "None of your spaces grant you a space-wide role — the spaces you can see are " +
    "shared with you per document. A CLI token is space-wide, so ask a space owner " +
    "for viewer or editor access on the space itself.",
};

export function loginErrorMessage(code: string): string {
  return LOGIN_ERRORS[code] ?? `Login failed: ${code}`;
}

export interface LoginOptions {
  /** Authenticate with an SSH key instead of opening a browser. */
  ssh?: boolean;
  /** A specific key file to sign with; implies `ssh`. */
  keyPath?: string;
}

export async function commandLogin(options: LoginOptions = {}): Promise<void> {
  const host = resolveHost();

  if (options.ssh || options.keyPath) {
    await loginWithSsh(host, options.keyPath);
    return;
  }

  // Random port in a range unlikely to clash with common dev servers.
  const port = 51000 + Math.floor(Math.random() * 8999);
  const state = randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${port}/callback`;

  let resolveCallback: (result: CliTokenResult) => void;
  let rejectCallback: (err: Error) => void;
  const callbackPromise = new Promise<CliTokenResult>((res, rej) => {
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
        rejectCallback(new Error(loginErrorMessage(error)));
        return htmlResponse({
          title: "Login failed",
          message: `${loginErrorMessage(error)} You can close this tab.`,
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
        const data = (await res.json()) as CliTokenResult;
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
    storeLogin(host, await callbackPromise);
  } finally {
    clearTimeout(timeout);
    server.stop();
  }
}

/** Persist what a login returned and tell the user what it is good for. */
function storeLogin(host: string, result: CliTokenResult): void {
  const { token, spaceId, permission, expiresAt } = result;

  const scope = [
    permission ? `${permission} access` : undefined,
    expiresAt ? `expires ${expiresAt.slice(0, 10)}` : undefined,
  ].filter((part): part is string => part !== undefined);

  const path = writeStoredConfig({ spaceId, accessToken: token });

  process.stdout.write(
    [
      "",
      `Logged in to ${host} (space ${spaceId}).`,
      ...(scope.length > 0 ? [`Token scope: ${scope.join(", ")}`] : []),
      `Credentials stored in ${path}`,
      // The host is env-only, so without the export the next command hits localhost.
      ...(host === DEFAULT_HOST
        ? []
        : ["", `Keep VEKTOR_HOST=${host} in your shell profile — it is not stored.`]),
      // Env vars still win, so a stale export would silently shadow this token.
      ...(process.env.VEKTOR_ACCESS_TOKEN
        ? [
            "",
            "Note: VEKTOR_ACCESS_TOKEN is set and takes precedence — unset it to use the stored token.",
          ]
        : []),
      "",
    ].join("\n"),
  );
}

/**
 * Choose the SSH key this machine signs with, and check the server agrees.
 *
 * There is no token to fetch: a signed request carries its own proof, so all
 * this does is settle *which* key — the agent may hold several and only some are
 * registered — and record that choice. What it writes is a fingerprint and a
 * space id, neither of them secret.
 */
async function loginWithSsh(host: string, keyPath?: string): Promise<void> {
  const signers = await discoverSshSigners(keyPath);
  if (signers.length === 0) {
    throw new Error(
      "No SSH keys found. Add one to your agent (ssh-add ~/.ssh/id_ed25519) or pass --key <path>.",
    );
  }

  const rejected: string[] = [];

  for (const signer of signers) {
    process.stderr.write(`Trying SSH key ${describeSigner(signer)}…\n`);

    let identity: { name?: string; email?: string };
    try {
      const response = await apiFetch(
        `${host}/api/v1/users/me`,
        {},
        {
          kind: "ssh",
          signer,
        },
      );
      if (response.status === 401 || response.status === 403) {
        // The server knows nothing of this key. Another one may still work.
        rejected.push(`${describeSigner(signer)}: not registered on ${host}`);
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => String(response.status));
        throw new Error(`Server refused the signature (${response.status}): ${text}`);
      }
      identity = (await response.json()) as { name?: string; email?: string };
    } catch (error) {
      // A key that cannot sign — no ssh-keygen, a declined passphrase — is worth
      // saying out loud, but the next key may still work.
      rejected.push(`${describeSigner(signer)}: ${errorMessage(error)}`);
      continue;
    }

    // Only an explicit choice is stored; without one every command discovers a
    // space for itself, which is what an unconfigured install already does.
    const spaceId = config().CLI_SPACE_ID;
    const path = writeSshLogin({
      spaceId,
      ...(signer.fingerprint
        ? { fingerprint: signer.fingerprint }
        : { keyPath: signer.label }),
    });

    process.stdout.write(
      [
        "",
        `Signed in to ${host} as ${identity.name ?? identity.email ?? "you"}.`,
        `Requests are signed with ${describeSigner(signer)}.`,
        `Key choice stored in ${path} — no token is kept anywhere.`,
        ...(host === DEFAULT_HOST
          ? []
          : ["", `Keep VEKTOR_HOST=${host} in your shell profile — it is not stored.`]),
        // An env token would win over the signature and quietly change identity.
        ...(process.env.VEKTOR_ACCESS_TOKEN
          ? [
              "",
              "Note: VEKTOR_ACCESS_TOKEN is set and takes precedence — unset it to sign with your key.",
            ]
          : []),
        "",
      ].join("\n"),
    );
    return;
  }

  throw new Error(
    [
      "SSH login failed.",
      ...rejected.map((line) => `  ${line}`),
      "",
      "Register the public key under user settings → Access Tokens → SSH Keys.",
    ].join("\n"),
  );
}

function describeSigner(signer: SshSigner): string {
  return signer.fingerprint ? `${signer.label} (${signer.fingerprint})` : signer.label;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function commandLogout(): void {
  const path = clearStoredConfig();
  process.stdout.write(
    path ? `Removed ${path}\n` : "Not logged in — nothing to remove.\n",
  );
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
