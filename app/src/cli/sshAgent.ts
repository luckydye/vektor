/**
 * Signing a login challenge with the user's SSH key, without ever reading the
 * private half.
 *
 * Two ways in, in the order ssh itself would take them: the agent on
 * `SSH_AUTH_SOCK`, which signs on request and is what makes a passphrased or
 * hardware-backed key usable non-interactively, and `ssh-keygen -Y sign` for a
 * key file when no agent holds it.
 *
 * Both produce the same armored SSHSIG, so the server does not know or care
 * which one signed.
 */

import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  encodeSshSignature,
  parseSshPublicKey,
  sshFingerprint,
  sshSignatureData,
} from "#utils/sshKeys.ts";

const AGENT_TIMEOUT_MS = 10_000;

// draft-miller-ssh-agent, message numbers.
const SSH_AGENT_FAILURE = 5;
const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;

/** Asks the agent for a SHA-2 RSA signature; SHA-1 is what it would produce otherwise. */
const SSH_AGENT_RSA_SHA2_512 = 4;

/** Tried in the order ssh reads them when no identity is named. */
const DEFAULT_KEY_FILES = ["id_ed25519", "id_ecdsa", "id_rsa"];

/** One way to sign a challenge, already resolved to a specific key. */
export interface SshSigner {
  /** How the CLI names this key while trying it. */
  label: string;
  /** Undefined only for a key file with no readable `.pub` beside it. */
  fingerprint?: string;
  sign(message: string, namespace: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Agent protocol
// ---------------------------------------------------------------------------

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

/**
 * One request, one response, one connection — agents handle far more traffic
 * than a login makes, and a connection per exchange keeps the framing trivial.
 */
function agentRequest(socketPath: string, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(AGENT_TIMEOUT_MS, () =>
      fail(new Error("ssh-agent did not respond")),
    );
    socket.on("error", (error) => fail(error));
    socket.on("connect", () =>
      socket.write(Buffer.concat([uint32(payload.length), payload])),
    );
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      if (settled) return;
      settled = true;
      const message = Buffer.from(buffer.subarray(4, 4 + length));
      socket.end();
      resolve(message);
    });
    socket.on("close", () => fail(new Error("ssh-agent closed the connection")));
  });
}

/** Reader for the length-prefixed fields of an agent reply. */
class Reader {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  byte(): number {
    return this.data[this.offset++];
  }

  uint32(): number {
    const value = this.data.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  string(): Buffer {
    const length = this.uint32();
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return Buffer.from(value);
  }
}

interface AgentIdentity {
  blob: Buffer;
  comment: string;
}

async function agentIdentities(socketPath: string): Promise<AgentIdentity[]> {
  const reply = new Reader(
    await agentRequest(socketPath, Buffer.from([SSH_AGENTC_REQUEST_IDENTITIES])),
  );
  if (reply.byte() !== SSH_AGENT_IDENTITIES_ANSWER) {
    throw new Error("ssh-agent refused to list identities");
  }

  const count = reply.uint32();
  const identities: AgentIdentity[] = [];
  for (let index = 0; index < count; index++) {
    identities.push({ blob: reply.string(), comment: reply.string().toString("utf8") });
  }
  return identities;
}

/**
 * Have the agent sign the SSHSIG preamble, then wrap its signature in the
 * container `ssh-keygen -Y sign` would have written. The agent signs bytes; the
 * envelope — namespace included — is built here and covered by that signature.
 */
async function agentSign(
  socketPath: string,
  identity: AgentIdentity,
  message: string,
  namespace: string,
): Promise<string> {
  const keyType = new Reader(identity.blob).string().toString("utf8");
  const data = sshSignatureData({
    namespace,
    hashAlgorithm: "sha512",
    message: Buffer.from(message, "utf8"),
  });

  const reply = new Reader(
    await agentRequest(
      socketPath,
      Buffer.concat([
        Buffer.from([SSH_AGENTC_SIGN_REQUEST]),
        sshString(identity.blob),
        sshString(data),
        uint32(keyType === "ssh-rsa" ? SSH_AGENT_RSA_SHA2_512 : 0),
      ]),
    ),
  );

  const type = reply.byte();
  if (type === SSH_AGENT_FAILURE) {
    throw new Error(`ssh-agent refused to sign with ${identity.comment || keyType}`);
  }
  if (type !== SSH_AGENT_SIGN_RESPONSE) {
    throw new Error("Unexpected ssh-agent response");
  }

  return encodeSshSignature({
    publicKey: identity.blob,
    namespace,
    hashAlgorithm: "sha512",
    message: Buffer.from(message, "utf8"),
    signature: reply.string(),
  });
}

// ---------------------------------------------------------------------------
// Key files
// ---------------------------------------------------------------------------

/** `ssh-keygen -Y sign`, which prompts for a passphrase on the terminal if it needs one. */
async function keygenSign(
  keyPath: string,
  message: string,
  namespace: string,
): Promise<string> {
  const process_ = Bun.spawn(
    ["ssh-keygen", "-Y", "sign", "-n", namespace, "-f", keyPath, "-"],
    { stdin: Buffer.from(message, "utf8"), stdout: "pipe", stderr: "pipe" },
  );

  const [signature, stderr, exitCode] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `ssh-keygen could not sign with ${keyPath}: ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  return signature;
}

/** The fingerprint of the key beside a private key file, when it is readable. */
function publicKeyFingerprint(keyPath: string): string | undefined {
  const publicPath = keyPath.endsWith(".pub") ? keyPath : `${keyPath}.pub`;
  try {
    return parseSshPublicKey(readFileSync(publicPath, "utf8")).fingerprint;
  } catch {
    // Signing does not need it — only the "trying key X" line does.
    return undefined;
  }
}

function fileSigner(keyPath: string): SshSigner {
  // `-f id_ed25519.pub` makes ssh-keygen look for the private key beside it, so
  // either half of the pair names the same signer.
  const privatePath = keyPath.endsWith(".pub") ? keyPath.slice(0, -4) : keyPath;
  return {
    label: privatePath,
    fingerprint: publicKeyFingerprint(privatePath),
    sign: (message, namespace) => keygenSign(privatePath, message, namespace),
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function agentSigners(socketPath: string, identities: AgentIdentity[]): SshSigner[] {
  return identities.map((identity) => ({
    label: identity.comment || "ssh-agent key",
    fingerprint: sshFingerprint(identity.blob.toString("base64")),
    sign: (message, namespace) => agentSign(socketPath, identity, message, namespace),
  }));
}

function defaultKeyFiles(): string[] {
  return DEFAULT_KEY_FILES.map((name) => join(homedir(), ".ssh", name)).filter((path) =>
    existsSync(path),
  );
}

/**
 * Every key worth trying, in the order to try them.
 *
 * The agent comes first because it can sign without a passphrase prompt; key
 * files fill in what it does not hold. Which of them the server accepts is the
 * server's answer to give, so all of them are offered rather than guessed
 * between.
 *
 * @param keyPath a specific key to use, from `--key`; nothing else is tried.
 */
export async function discoverSshSigners(keyPath?: string): Promise<SshSigner[]> {
  if (keyPath) return [fileSigner(keyPath)];

  const socketPath = process.env.SSH_AUTH_SOCK;
  const identities = socketPath ? await agentIdentities(socketPath).catch(() => []) : [];
  const signers = socketPath ? agentSigners(socketPath, identities) : [];

  const known = new Set(signers.map((signer) => signer.fingerprint));
  for (const path of defaultKeyFiles()) {
    const signer = fileSigner(path);
    // A key the agent already holds signs without a passphrase prompt; the file
    // is the same key and would only ask for one.
    if (signer.fingerprint && known.has(signer.fingerprint)) continue;
    signers.push(signer);
  }

  return signers;
}
