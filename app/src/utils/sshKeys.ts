/**
 * OpenSSH public keys and SSHSIG signatures, in terms `node:crypto` can verify.
 *
 * Vektor ships as a single binary with no external dependencies, so this parses
 * the wire formats itself rather than shelling out to `ssh-keygen`: an
 * `authorized_keys` line on the way in, and the armored SSHSIG blob that
 * `ssh-keygen -Y sign` (or an ssh-agent signature wrapped the same way) produces
 * on the way out.
 *
 * Formats: RFC 4253 §6.6 for the key blobs, PROTOCOL.sshsig for the signature.
 */

import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { SSH_SIGNATURE_NAMESPACE } from "#utils/sshRequestSignature.ts";

/** Below this an RSA key is not worth accepting as a standing credential. */
const MIN_RSA_MODULUS_BITS = 2048;

const SSHSIG_MAGIC = "SSHSIG";
const SSHSIG_VERSION = 1;

const ARMOR_HEADER = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_FOOTER = "-----END SSH SIGNATURE-----";

/** Curve name → the hash SSH pairs it with, and the field size of one half of the signature. */
const ECDSA_CURVES: Record<
  string,
  { jwkCurve: string; hash: "sha256" | "sha384" | "sha512"; fieldBytes: number }
> = {
  nistp256: { jwkCurve: "P-256", hash: "sha256", fieldBytes: 32 },
  nistp384: { jwkCurve: "P-384", hash: "sha384", fieldBytes: 48 },
  nistp521: { jwkCurve: "P-521", hash: "sha512", fieldBytes: 66 },
};

/** A key type is supported only if it appears here — nothing falls through to a default. */
const SUPPORTED_KEY_TYPES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
] as const;

export type SshKeyType = (typeof SUPPORTED_KEY_TYPES)[number];

export class SshKeyError extends Error {}

export interface ParsedSshPublicKey {
  type: SshKeyType;
  /** The wire-format blob, base64 encoded exactly as an `authorized_keys` line carries it. */
  publicKey: string;
  /** `SHA256:…`, the same string `ssh-keygen -lf` prints. */
  fingerprint: string;
  /** The trailing comment of the line, usually `user@host`. Empty when absent. */
  comment: string;
}

// ---------------------------------------------------------------------------
// SSH wire format
// ---------------------------------------------------------------------------

/** Sequential reader for the length-prefixed SSH wire encoding. */
class SshReader {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  get done(): boolean {
    return this.offset >= this.data.length;
  }

  bytes(length: number): Buffer {
    if (this.offset + length > this.data.length) {
      throw new SshKeyError("Truncated SSH data");
    }
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  uint32(): number {
    return this.bytes(4).readUInt32BE(0);
  }

  string(): Buffer {
    return this.bytes(this.uint32());
  }

  text(): string {
    return this.string().toString("utf8");
  }

  /**
   * An mpint as a fixed-width unsigned integer: SSH stores it signed, so a value
   * whose top bit is set carries a leading zero byte that JWK must not repeat.
   */
  unsignedInt(): Buffer {
    const raw = this.string();
    let start = 0;
    while (start < raw.length - 1 && raw[start] === 0) start++;
    return raw.subarray(start);
  }
}

function sshString(value: string | Buffer): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

// ---------------------------------------------------------------------------
// Public keys
// ---------------------------------------------------------------------------

function isSupportedKeyType(type: string): type is SshKeyType {
  return (SUPPORTED_KEY_TYPES as readonly string[]).includes(type);
}

/** `SHA256:` plus the unpadded base64 of the blob's digest, as OpenSSH prints it. */
export function sshFingerprint(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest();
  return `SHA256:${digest.toString("base64").replace(/=+$/, "")}`;
}

/**
 * Parse one `authorized_keys` line into the parts worth storing.
 *
 * Throws `SshKeyError` with a message meant for the person pasting the key —
 * every rejection here is something they can fix.
 */
export function parseSshPublicKey(line: string): ParsedSshPublicKey {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new SshKeyError(
      "Not an SSH public key. Paste the contents of a .pub file, e.g. `ssh-ed25519 AAAA… you@host`.",
    );
  }

  const [type, encoded, ...commentParts] = parts;
  if (!isSupportedKeyType(type)) {
    throw new SshKeyError(
      `Unsupported key type "${type}". Supported: ${SUPPORTED_KEY_TYPES.join(", ")}.`,
    );
  }

  let blob: Buffer;
  try {
    blob = Buffer.from(encoded, "base64");
  } catch {
    throw new SshKeyError("Key data is not valid base64");
  }
  if (
    blob.length === 0 ||
    blob.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw new SshKeyError("Key data is not valid base64");
  }

  // The blob names its own type; a line whose prefix disagrees with it is either
  // corrupt or an attempt to have the two read differently.
  const reader = new SshReader(blob);
  if (reader.text() !== type) {
    throw new SshKeyError("Key type does not match the key data");
  }

  // Rejects malformed key material now rather than at the first login attempt.
  publicKeyObject(type, new SshReader(blob));

  return {
    type,
    publicKey: encoded,
    fingerprint: sshFingerprint(encoded),
    comment: commentParts.join(" "),
  };
}

/**
 * Turn a key blob into something `verify()` accepts.
 *
 * @param reader positioned at the start of the blob; its type string is read here.
 */
function publicKeyObject(type: SshKeyType, reader: SshReader): KeyObject {
  const blobType = reader.text();
  if (blobType !== type) {
    throw new SshKeyError("Key type does not match the key data");
  }

  if (type === "ssh-ed25519") {
    const raw = reader.string();
    if (raw.length !== 32) {
      throw new SshKeyError("Malformed ed25519 key");
    }
    // SPKI wrapper for id-Ed25519; the raw key is the whole payload.
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    return createPublicKey({ key: der, format: "der", type: "spki" });
  }

  if (type === "ssh-rsa") {
    const exponent = reader.unsignedInt();
    const modulus = reader.unsignedInt();
    if (modulus.length * 8 < MIN_RSA_MODULUS_BITS) {
      throw new SshKeyError(`RSA keys must be at least ${MIN_RSA_MODULUS_BITS} bits`);
    }
    return createPublicKey({
      key: { kty: "RSA", n: base64url(modulus), e: base64url(exponent) },
      format: "jwk",
    });
  }

  const curve = ECDSA_CURVES[type.slice("ecdsa-sha2-".length)];
  if (!curve) {
    throw new SshKeyError(`Unsupported key type "${type}"`);
  }
  // The curve is named twice — once in the type, once in the blob — and both
  // must agree, or the point would be read against the wrong field.
  if (reader.text() !== type.slice("ecdsa-sha2-".length)) {
    throw new SshKeyError("Curve does not match the key type");
  }
  const point = reader.string();
  if (point[0] !== 0x04 || point.length !== 1 + curve.fieldBytes * 2) {
    throw new SshKeyError("Only uncompressed ECDSA points are supported");
  }
  return createPublicKey({
    key: {
      kty: "EC",
      crv: curve.jwkCurve,
      x: base64url(point.subarray(1, 1 + curve.fieldBytes)),
      y: base64url(point.subarray(1 + curve.fieldBytes)),
    },
    format: "jwk",
  });
}

// ---------------------------------------------------------------------------
// SSHSIG
// ---------------------------------------------------------------------------

function decodeArmor(signature: string): Buffer {
  const trimmed = signature.trim();
  const start = trimmed.indexOf(ARMOR_HEADER);
  const end = trimmed.indexOf(ARMOR_FOOTER);
  if (start === -1 || end === -1 || end < start) {
    throw new SshKeyError("Signature is not an armored SSH signature");
  }
  const body = trimmed.slice(start + ARMOR_HEADER.length, end).replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}

/**
 * The bytes SSHSIG actually signs: the message never appears in them directly,
 * only its digest, and the namespace is inside — which is what stops a signature
 * made for git commit signing from being replayed as a login.
 */
function signedBlob(namespace: string, hashAlgorithm: string, digest: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(SSHSIG_MAGIC, "utf8"),
    sshString(namespace),
    sshString(""),
    sshString(hashAlgorithm),
    sshString(digest),
  ]);
}

export interface VerifiedSshSignature {
  fingerprint: string;
  publicKey: string;
  type: SshKeyType;
}

/**
 * Verify an armored SSHSIG over `message` and return the key that made it.
 *
 * The caller decides whether that key belongs to anyone: this says only that
 * whoever holds its private half signed this exact message under this namespace.
 */
export function verifySshSignature(options: {
  signature: string;
  message: string | Buffer;
  namespace?: string;
}): VerifiedSshSignature {
  const namespace = options.namespace ?? SSH_SIGNATURE_NAMESPACE;
  const reader = new SshReader(decodeArmor(options.signature));

  if (reader.bytes(SSHSIG_MAGIC.length).toString("utf8") !== SSHSIG_MAGIC) {
    throw new SshKeyError("Signature is not in SSHSIG format");
  }
  if (reader.uint32() !== SSHSIG_VERSION) {
    throw new SshKeyError("Unsupported SSHSIG version");
  }

  const keyBlob = reader.string();
  if (reader.text() !== namespace) {
    throw new SshKeyError(`Signature was not made for the "${namespace}" namespace`);
  }
  reader.string(); // reserved, ignored by the format
  const hashAlgorithm = reader.text();
  if (hashAlgorithm !== "sha256" && hashAlgorithm !== "sha512") {
    throw new SshKeyError(`Unsupported signature hash "${hashAlgorithm}"`);
  }
  const signatureBlob = new SshReader(reader.string());

  const keyType = new SshReader(keyBlob).text();
  if (!isSupportedKeyType(keyType)) {
    throw new SshKeyError(`Unsupported key type "${keyType}"`);
  }
  const key = publicKeyObject(keyType, new SshReader(keyBlob));

  const message = Buffer.isBuffer(options.message)
    ? options.message
    : Buffer.from(options.message, "utf8");
  const data = signedBlob(
    namespace,
    hashAlgorithm,
    createHash(hashAlgorithm).update(message).digest(),
  );

  if (!verifySignatureBlob(keyType, key, signatureBlob, data)) {
    throw new SshKeyError("Signature does not match the challenge");
  }

  const publicKey = keyBlob.toString("base64");
  return { fingerprint: sshFingerprint(publicKey), publicKey, type: keyType };
}

function verifySignatureBlob(
  keyType: SshKeyType,
  key: KeyObject,
  signature: SshReader,
  data: Buffer,
): boolean {
  const algorithm = signature.text();

  if (keyType === "ssh-ed25519") {
    if (algorithm !== "ssh-ed25519") return false;
    return verify(null, data, key, signature.string());
  }

  if (keyType === "ssh-rsa") {
    // Plain "ssh-rsa" is SHA-1 signed; only the SHA-2 algorithms are accepted.
    const hash =
      algorithm === "rsa-sha2-256"
        ? "sha256"
        : algorithm === "rsa-sha2-512"
          ? "sha512"
          : undefined;
    if (!hash) return false;
    return verify(hash, data, key, signature.string());
  }

  if (algorithm !== keyType) return false;
  const curve = ECDSA_CURVES[keyType.slice("ecdsa-sha2-".length)];
  if (!curve) return false;

  // SSH encodes r and s as two mpints inside a nested blob; `ieee-p1363` wants
  // them concatenated, each padded to the field width.
  const parts = new SshReader(signature.string());
  const r = parts.unsignedInt();
  const s = parts.unsignedInt();
  if (r.length > curve.fieldBytes || s.length > curve.fieldBytes) return false;
  const raw = Buffer.alloc(curve.fieldBytes * 2);
  r.copy(raw, curve.fieldBytes - r.length);
  s.copy(raw, curve.fieldBytes * 2 - s.length);

  return verify(curve.hash, data, { key, dsaEncoding: "ieee-p1363" }, raw);
}

/** Build the armored SSHSIG a raw signature belongs in. Used by the CLI's agent signer. */
export function encodeSshSignature(options: {
  publicKey: Buffer;
  namespace: string;
  hashAlgorithm: "sha256" | "sha512";
  message: Buffer;
  /** The `string algorithm, string signature` blob an agent returns. */
  signature: Buffer;
}): string {
  const blob = Buffer.concat([
    Buffer.from(SSHSIG_MAGIC, "utf8"),
    (() => {
      const version = Buffer.alloc(4);
      version.writeUInt32BE(SSHSIG_VERSION);
      return version;
    })(),
    sshString(options.publicKey),
    sshString(options.namespace),
    sshString(""),
    sshString(options.hashAlgorithm),
    sshString(options.signature),
  ]);

  const lines = blob.toString("base64").match(/.{1,70}/g) ?? [];
  return [ARMOR_HEADER, ...lines, ARMOR_FOOTER, ""].join("\n");
}

/** The bytes an agent has to sign for `encodeSshSignature` to produce a valid SSHSIG. */
export function sshSignatureData(options: {
  namespace: string;
  hashAlgorithm: "sha256" | "sha512";
  message: Buffer;
}): Buffer {
  return signedBlob(
    options.namespace,
    options.hashAlgorithm,
    createHash(options.hashAlgorithm).update(options.message).digest(),
  );
}
