/**
 * How the CLI authenticates: an ssh-agent that answers the way OpenSSH's does,
 * and the signature the CLI puts on each request from what that agent signs.
 *
 * Two things are being checked. That the agent protocol is spoken correctly —
 * the agent signs bytes, and the SSHSIG envelope around them is assembled on
 * this side — and that a signed request carries a signature the server will
 * accept for that request and no other.
 */

import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, resetCredential } from "#cli/request.ts";
import { writeSshLogin } from "#cli/resolve.ts";
import { discoverSshSigners } from "#cli/sshAgent.ts";
import { verifySshSignature } from "#utils/sshKeys.ts";
import { canonicalRequest, parseAuthorization } from "#utils/sshRequestSignature.ts";

const SOCKET_DIR = "/tmp/vektor-ssh-agent-spec";
const CHALLENGE = "0d1c2b3a49586776";

const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;
const SSH_AGENT_FAILURE = 5;

function sshString(value: string | Buffer): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function frame(payload: Buffer): Buffer {
  return Buffer.concat([uint32(payload.length), payload]);
}

function ed25519Blob(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  return Buffer.concat([
    sshString("ssh-ed25519"),
    sshString(Buffer.from(jwk.x, "base64url")),
  ]);
}

interface StubAgent {
  server: Server;
  socketPath: string;
  /** The data the agent was last asked to sign, as it received it. */
  signedData?: Buffer;
}

/**
 * An agent holding one ed25519 key. `refuse` makes it answer SIGN_REQUEST the
 * way a real agent does when the key is confirm-protected and the user says no.
 */
function startStubAgent(options: { refuse?: boolean } = {}): Promise<StubAgent> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const blob = ed25519Blob(publicKey);
  const socketPath = join(
    SOCKET_DIR,
    `agent-${Math.random().toString(36).slice(2)}.sock`,
  );

  const agent: StubAgent = { server: createServer(), socketPath };

  agent.server.on("connection", (socket) => {
    socket.on("data", (chunk: Buffer) => {
      const payload = chunk.subarray(4);
      const type = payload[0];

      if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
        socket.write(
          frame(
            Buffer.concat([
              Buffer.from([SSH_AGENT_IDENTITIES_ANSWER]),
              uint32(1),
              sshString(blob),
              sshString("stub@agent"),
            ]),
          ),
        );
        return;
      }

      if (type === SSH_AGENTC_SIGN_REQUEST) {
        if (options.refuse) {
          socket.write(frame(Buffer.from([SSH_AGENT_FAILURE])));
          return;
        }
        // key blob, then the data to sign, then flags.
        let offset = 1;
        const readString = () => {
          const length = payload.readUInt32BE(offset);
          const value = payload.subarray(offset + 4, offset + 4 + length);
          offset += 4 + length;
          return Buffer.from(value);
        };
        readString();
        const data = readString();
        agent.signedData = data;

        socket.write(
          frame(
            Buffer.concat([
              Buffer.from([SSH_AGENT_SIGN_RESPONSE]),
              sshString(
                Buffer.concat([
                  sshString("ssh-ed25519"),
                  sshString(sign(null, data, privateKey)),
                ]),
              ),
            ]),
          ),
        );
      }
    });
  });

  return new Promise((resolve) => {
    agent.server.listen(socketPath, () => resolve(agent));
  });
}

const savedEnv = { ...process.env };
let agent: StubAgent | undefined;

beforeEach(() => {
  rmSync(SOCKET_DIR, { recursive: true, force: true });
  mkdirSync(SOCKET_DIR, { recursive: true });
  // Otherwise the developer's own ~/.ssh keys and stored login join in.
  process.env.HOME = SOCKET_DIR;
  process.env.XDG_CONFIG_HOME = join(SOCKET_DIR, "config");
  delete process.env.VEKTOR_ACCESS_TOKEN;
  delete process.env.VEKTOR_SSH_KEY;
  resetCredential();
});

afterEach(() => {
  vi.restoreAllMocks();
  agent?.server.close();
  agent = undefined;
  rmSync(SOCKET_DIR, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("discoverSshSigners", () => {
  it("offers the agent's identities, named by their comment", async () => {
    agent = await startStubAgent();
    process.env.SSH_AUTH_SOCK = agent.socketPath;

    const signers = await discoverSshSigners();

    expect(signers).toHaveLength(1);
    expect(signers[0].label).toBe("stub@agent");
    expect(signers[0].fingerprint).toMatch(/^SHA256:/);
  });

  it("produces a signature the server accepts, over the challenge", async () => {
    agent = await startStubAgent();
    process.env.SSH_AUTH_SOCK = agent.socketPath;

    const [signer] = await discoverSshSigners();
    const signature = await signer.sign(CHALLENGE, "vektor-cli");
    const verified = verifySshSignature({ signature, message: CHALLENGE });

    expect(verified.fingerprint).toBe(signer.fingerprint);
    expect(verified.type).toBe("ssh-ed25519");

    // The agent never saw the challenge itself, only the SSHSIG preamble over
    // its digest — which is what binds the namespace into the signature.
    expect(agent.signedData?.subarray(0, 6).toString()).toBe("SSHSIG");
    expect(agent.signedData?.includes("vektor-cli")).toBe(true);
    expect(
      agent.signedData?.includes(createHash("sha512").update(CHALLENGE).digest()),
    ).toBe(true);
  });

  it("reports a refused signature rather than producing one", async () => {
    agent = await startStubAgent({ refuse: true });
    process.env.SSH_AUTH_SOCK = agent.socketPath;

    const [signer] = await discoverSshSigners();

    await expect(signer.sign(CHALLENGE, "vektor-cli")).rejects.toThrow(/refused/);
  });

  it("finds nothing when there is no agent and no key files", async () => {
    process.env.SSH_AUTH_SOCK = "";

    expect(await discoverSshSigners()).toEqual([]);
  });

  it("survives an SSH_AUTH_SOCK pointing at nothing", async () => {
    process.env.SSH_AUTH_SOCK = join(SOCKET_DIR, "missing.sock");

    expect(await discoverSshSigners()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Signed requests
// ---------------------------------------------------------------------------

const HOST = "https://vektor.example.com";

/** Captures what `apiFetch` put on the wire, and answers with an empty 200. */
function captureRequest(): { seen: Array<{ url: string; init?: RequestInit }> } {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return Promise.resolve(Response.json({ ok: true }));
    },
  );
  return { seen };
}

function authorizationOf(init: RequestInit | undefined): string {
  const value = new Headers(init?.headers).get("Authorization");
  expect(value).toBeTruthy();
  return value as string;
}

describe("signed requests", () => {
  it("signs the method, path and body of the request it is sent with", async () => {
    agent = await startStubAgent();
    process.env.SSH_AUTH_SOCK = agent.socketPath;
    const [signer] = await discoverSshSigners();
    writeSshLogin({ fingerprint: signer.fingerprint });
    resetCredential();

    const { seen } = captureRequest();
    const body = JSON.stringify({ title: "Signed" });
    await apiFetch(`${HOST}/api/v1/spaces/space_1/documents?draft=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const presented = parseAuthorization(authorizationOf(seen[0].init));
    expect(presented).toBeDefined();

    const verified = verifySshSignature({
      signature: (presented as NonNullable<typeof presented>).signature,
      message: canonicalRequest({
        method: "POST",
        path: "/api/v1/spaces/space_1/documents?draft=1",
        body,
        timestamp: (presented as NonNullable<typeof presented>).timestamp,
        nonce: (presented as NonNullable<typeof presented>).nonce,
      }),
    });
    expect(verified.fingerprint).toBe(signer.fingerprint);
  });

  /** The whole point of signing the request rather than holding a token. */
  it("makes a signature that does not verify for another path", async () => {
    agent = await startStubAgent();
    process.env.SSH_AUTH_SOCK = agent.socketPath;
    const [signer] = await discoverSshSigners();
    writeSshLogin({ fingerprint: signer.fingerprint });
    resetCredential();

    const { seen } = captureRequest();
    await apiFetch(`${HOST}/api/v1/spaces/space_1/documents`);

    const presented = parseAuthorization(authorizationOf(seen[0].init));
    expect(() =>
      verifySshSignature({
        signature: (presented as NonNullable<typeof presented>).signature,
        message: canonicalRequest({
          method: "DELETE",
          path: "/api/v1/spaces/space_1/documents/doc_1",
          body: "",
          timestamp: (presented as NonNullable<typeof presented>).timestamp,
          nonce: (presented as NonNullable<typeof presented>).nonce,
        }),
      }),
    ).toThrow();
  });

  it("gives every request its own nonce", async () => {
    agent = await startStubAgent();
    process.env.SSH_AUTH_SOCK = agent.socketPath;
    const [signer] = await discoverSshSigners();
    writeSshLogin({ fingerprint: signer.fingerprint });
    resetCredential();

    const { seen } = captureRequest();
    await apiFetch(`${HOST}/api/v1/spaces`);
    await apiFetch(`${HOST}/api/v1/spaces`);

    const [first, second] = seen.map(({ init }) =>
      parseAuthorization(authorizationOf(init)),
    );
    expect(first?.nonce).not.toBe(second?.nonce);
  });

  /** A token beats a key: an existing login must not change meaning silently. */
  it("sends a stored access token as a bearer token instead of signing", async () => {
    agent = await startStubAgent();
    process.env.SSH_AUTH_SOCK = agent.socketPath;
    process.env.VEKTOR_ACCESS_TOKEN = "at_from_env";
    resetCredential();

    const { seen } = captureRequest();
    await apiFetch(`${HOST}/api/v1/spaces`);

    expect(authorizationOf(seen[0].init)).toBe("Bearer at_from_env");
  });

  it("refuses to sign as a different key than the one that was chosen", async () => {
    agent = await startStubAgent();
    process.env.SSH_AUTH_SOCK = agent.socketPath;
    writeSshLogin({ fingerprint: "SHA256:akeythatisnolongerloaded" });
    resetCredential();

    await expect(apiFetch(`${HOST}/api/v1/spaces`)).rejects.toThrow(/not available/);
  });
});
