/**
 * How the CLI proves who it is, and the one place a request goes out.
 *
 * Two credentials, in this order: an access token when one is configured (what
 * the browser login stores, and what CI usually sets), otherwise an SSH key.
 * The SSH path stores nothing — every request carries its own signature over
 * that request's method, path and body, so there is no standing secret on disk
 * to steal and nothing to revoke but the key itself.
 */

import { randomBytes } from "node:crypto";
import { config } from "#config";
import {
  canonicalRequest,
  formatAuthorization,
  SSH_SIGNATURE_NAMESPACE,
} from "#utils/sshRequestSignature.ts";
import { readStoredConfig, resolveHost } from "./resolve.ts";
import { discoverSshSigners, type SshSigner } from "./sshAgent.ts";

export type CliCredential =
  | { kind: "token"; token: string }
  | { kind: "ssh"; signer: SshSigner }
  | { kind: "none" };

/** Resolved once: discovering the agent's identities is a round trip. */
let pending: Promise<CliCredential> | undefined;

export function resolveCredential(): Promise<CliCredential> {
  pending ??= discoverCredential();
  return pending;
}

/** For tests, and for `login`, which changes what a later call would resolve. */
export function resetCredential(): void {
  pending = undefined;
}

async function discoverCredential(): Promise<CliCredential> {
  const token = config().CLI_ACCESS_TOKEN || readStoredConfig().accessToken;
  if (token) return { kind: "token", token };

  const stored = readStoredConfig();
  const keyPath = process.env.VEKTOR_SSH_KEY || stored.sshKeyPath;
  const signers = await discoverSshSigners(keyPath);

  if (signers.length === 0) return { kind: "none" };
  if (keyPath) return { kind: "ssh", signer: signers[0] };

  // A key chosen by `vektor login --ssh`. Gone from the agent is worth saying
  // plainly: the alternative is silently signing as somebody else's key.
  if (stored.sshKey) {
    const chosen = signers.find((signer) => signer.fingerprint === stored.sshKey);
    if (!chosen) {
      throw new Error(
        `SSH key ${stored.sshKey} is not available — add it to your agent (ssh-add) or run: vektor login --ssh`,
      );
    }
    return { kind: "ssh", signer: chosen };
  }

  if (signers.length > 1) {
    throw new Error(
      "Several SSH keys are available and none is chosen. Run: vektor login --ssh",
    );
  }
  return { kind: "ssh", signer: signers[0] };
}

/**
 * The `Authorization` value for one request, or none when this machine has no
 * credential. Exported for `vektor mcp`, which drives its own requests.
 */
export async function authorizeRequest(
  request: { method: string; path: string; body: Uint8Array | string },
  credential?: CliCredential,
): Promise<string | undefined> {
  return await authorization(credential ?? (await resolveCredential()), request);
}

async function authorization(
  credential: CliCredential,
  request: { method: string; path: string; body: Uint8Array | string },
): Promise<string | undefined> {
  if (credential.kind === "token") return `Bearer ${credential.token}`;
  if (credential.kind === "none") return undefined;

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");
  const signature = await credential.signer.sign(
    canonicalRequest({ ...request, timestamp, nonce }),
    SSH_SIGNATURE_NAMESPACE,
  );
  return formatAuthorization({ timestamp, nonce, signature });
}

/**
 * A request to the API, authenticated with whatever this machine has.
 *
 * A signature covers the exact bytes that go out, so a body the runtime would
 * serialize for us — a FormData, a file — is materialized here first. A string
 * body is already those bytes and passes through untouched.
 *
 * @param credential overrides the resolved one — `login` uses it to try a key
 *   that has not been chosen yet.
 */
export async function apiFetch(
  url: string,
  init: RequestInit = {},
  credential?: CliCredential,
): Promise<Response> {
  const headers = new Headers(init.headers);
  let body: BodyInit | undefined = init.body ?? undefined;
  let bytes: Uint8Array | string = "";

  if (typeof body === "string" || body instanceof Uint8Array) {
    bytes = body;
  } else if (body != null) {
    // Only a Request can say what a FormData or a file becomes on the wire —
    // the multipart boundary included, which is why the header comes with it.
    const request = new Request(url, { ...init, headers });
    const contentType = request.headers.get("Content-Type");
    const buffered = await request.arrayBuffer();
    bytes = new Uint8Array(buffered);
    body = buffered;
    if (contentType && !headers.has("Content-Type")) {
      headers.set("Content-Type", contentType);
    }
  }

  const target = new URL(url);
  const value = await authorizeRequest(
    {
      method: init.method ?? "GET",
      path: `${target.pathname}${target.search}`,
      body: bytes,
    },
    credential,
  );
  if (value) headers.set("Authorization", value);

  return await fetch(url, { ...init, headers, body });
}

/** The same request, with the API's error body folded into the thrown message. */
export async function apiJson<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await apiFetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => String(response.status));
    const path = new URL(url).pathname;
    throw new Error(
      `API ${init.method ?? "GET"} ${path} failed (${response.status}): ${text}`,
    );
  }
  return (await response.json()) as T;
}

async function resolveSpaceId(host: string): Promise<string> {
  const configured = config().CLI_SPACE_ID || readStoredConfig().spaceId;
  if (configured) return configured;

  const response = await apiFetch(`${host}/api/v1/spaces`);
  if (!response.ok) {
    throw new Error(`Failed to discover spaces from ${host} (${response.status})`);
  }
  const spaces = (await response.json()) as Array<{ id: string }>;
  if (!spaces.length) throw new Error("No spaces found on server");
  return spaces[0].id;
}

/**
 * Everything a command needs to reach the API. Discovering the space may cost a
 * request, so call this once per command rather than per API call.
 */
export async function resolveConfig(): Promise<{ host: string; spaceId: string }> {
  const host = resolveHost();
  return { host, spaceId: await resolveSpaceId(host) };
}
