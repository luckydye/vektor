/**
 * The CLI's ssh-agent client, against an agent that answers the way OpenSSH's
 * does. The point is the wire protocol: the agent signs bytes, and what makes
 * those bytes a Vektor login — the SSHSIG envelope, the namespace, the hash —
 * is assembled on this side.
 */

import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSshSigners } from "#cli/sshAgent.ts";
import { verifySshSignature } from "#utils/sshKeys.ts";

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
  // Otherwise the developer's own ~/.ssh keys join the list.
  process.env.HOME = SOCKET_DIR;
});

afterEach(() => {
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
