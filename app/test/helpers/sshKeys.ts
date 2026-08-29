/**
 * SSH keys and SSHSIG signatures for tests, built from `node:crypto` rather than
 * from the code under test: the wire encoding is written out here so a spec that
 * passes is evidence the parser reads the format, not that it agrees with
 * itself.
 */

import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";

export interface TestSshKey {
  /** One authorized_keys line, ready to POST. */
  line: string;
  /** The base64 key blob, as the API stores it. */
  publicKey: string;
  /** Signs a message the way `ssh-keygen -Y sign` would. */
  sign(message: string, options?: { namespace?: string }): string;
}

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

/** SSH's signed big-endian integer: a leading zero where the top bit is set. */
export function mpint(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  return sshString(
    trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed,
  );
}

function jwkPart(key: KeyObject, part: string): Buffer {
  const jwk = key.export({ format: "jwk" }) as Record<string, string>;
  return Buffer.from(jwk[part], "base64url");
}

function armor(blob: Buffer): string {
  const lines = blob.toString("base64").match(/.{1,70}/g) ?? [];
  return [
    "-----BEGIN SSH SIGNATURE-----",
    ...lines,
    "-----END SSH SIGNATURE-----",
    "",
  ].join("\n");
}

/** The SSHSIG container, with the signature blob supplied by the caller's key. */
export function sshsig(options: {
  publicKey: Buffer;
  namespace: string;
  hashAlgorithm: "sha256" | "sha512";
  signature: Buffer;
}): string {
  return armor(
    Buffer.concat([
      Buffer.from("SSHSIG", "utf8"),
      uint32(1),
      sshString(options.publicKey),
      sshString(options.namespace),
      sshString(""),
      sshString(options.hashAlgorithm),
      sshString(options.signature),
    ]),
  );
}

/** The bytes SSHSIG covers: the message appears only as a digest. */
export function sshsigPreamble(
  namespace: string,
  hashAlgorithm: "sha256" | "sha512",
  digest: Buffer,
): Buffer {
  return Buffer.concat([
    Buffer.from("SSHSIG", "utf8"),
    sshString(namespace),
    sshString(""),
    sshString(hashAlgorithm),
    sshString(digest),
  ]);
}

const DEFAULT_NAMESPACE = "vektor-cli";

export function generateEd25519Key(comment = "test@vektor"): TestSshKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const blob = Buffer.concat([
    sshString("ssh-ed25519"),
    sshString(jwkPart(publicKey, "x")),
  ]);

  return {
    line: `ssh-ed25519 ${blob.toString("base64")} ${comment}`,
    publicKey: blob.toString("base64"),
    sign(message, options = {}) {
      const namespace = options.namespace ?? DEFAULT_NAMESPACE;
      const data = sshsigPreamble(
        namespace,
        "sha512",
        createHash("sha512").update(message).digest(),
      );
      return sshsig({
        publicKey: blob,
        namespace,
        hashAlgorithm: "sha512",
        signature: Buffer.concat([
          sshString("ssh-ed25519"),
          sshString(sign(null, data, privateKey)),
        ]),
      });
    },
  };
}

export function generateRsaKey(modulusLength = 2048, comment = "rsa@vektor"): TestSshKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength });
  const blob = Buffer.concat([
    sshString("ssh-rsa"),
    mpint(jwkPart(publicKey, "e")),
    mpint(jwkPart(publicKey, "n")),
  ]);

  return {
    line: `ssh-rsa ${blob.toString("base64")} ${comment}`,
    publicKey: blob.toString("base64"),
    sign(message, options = {}) {
      const namespace = options.namespace ?? DEFAULT_NAMESPACE;
      const data = sshsigPreamble(
        namespace,
        "sha512",
        createHash("sha512").update(message).digest(),
      );
      return sshsig({
        publicKey: blob,
        namespace,
        hashAlgorithm: "sha512",
        signature: Buffer.concat([
          sshString("rsa-sha2-512"),
          sshString(sign("sha512", data, privateKey)),
        ]),
      });
    },
  };
}

export function generateEcdsaKey(comment = "ecdsa@vektor"): TestSshKey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    jwkPart(publicKey, "x"),
    jwkPart(publicKey, "y"),
  ]);
  const blob = Buffer.concat([
    sshString("ecdsa-sha2-nistp256"),
    sshString("nistp256"),
    sshString(point),
  ]);

  return {
    line: `ecdsa-sha2-nistp256 ${blob.toString("base64")} ${comment}`,
    publicKey: blob.toString("base64"),
    sign(message, options = {}) {
      const namespace = options.namespace ?? DEFAULT_NAMESPACE;
      const data = sshsigPreamble(
        namespace,
        "sha512",
        createHash("sha512").update(message).digest(),
      );
      // ECDSA signatures travel as two mpints inside a nested blob.
      const raw = sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
      return sshsig({
        publicKey: blob,
        namespace,
        hashAlgorithm: "sha512",
        signature: Buffer.concat([
          sshString("ecdsa-sha2-nistp256"),
          sshString(Buffer.concat([mpint(raw.subarray(0, 32)), mpint(raw.subarray(32))])),
        ]),
      });
    },
  };
}

/**
 * Re-wrap a signature so it advertises a different public key, leaving the
 * signature bytes alone. Verification must not take the advertised key's word
 * for it.
 */
export function reattributeSignature(armored: string, publicKey: string): string {
  const body = armored
    .replace("-----BEGIN SSH SIGNATURE-----", "")
    .replace("-----END SSH SIGNATURE-----", "")
    .replace(/\s+/g, "");
  const blob = Buffer.from(body, "base64");

  let offset = "SSHSIG".length + 4; // magic and version
  const readString = (): Buffer => {
    const length = blob.readUInt32BE(offset);
    const value = blob.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
    return Buffer.from(value);
  };

  readString(); // the public key being replaced
  const namespace = readString().toString("utf8");
  readString(); // reserved
  const hashAlgorithm = readString().toString("utf8") as "sha256" | "sha512";
  const signature = readString();

  return sshsig({
    publicKey: Buffer.from(publicKey, "base64"),
    namespace,
    hashAlgorithm,
    signature,
  });
}
