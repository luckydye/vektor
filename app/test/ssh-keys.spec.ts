/**
 * SSH login rests on two things being read correctly: an `authorized_keys` line,
 * and an SSHSIG signature over a challenge. Both are parsed here rather than by
 * `ssh-keygen`, so these specs drive the wire formats directly — the fixtures are
 * built by `test/helpers/sshKeys.ts`, which encodes them independently.
 */

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseSshPublicKey,
  SshKeyError,
  sshFingerprint,
  verifySshSignature,
} from "#utils/sshKeys.ts";
import {
  generateEcdsaKey,
  generateEd25519Key,
  generateRsaKey,
  reattributeSignature,
  sshsig,
  sshsigPreamble,
} from "./helpers/sshKeys.ts";

const CHALLENGE = "5f2c9a1b4e8d7c6a3b0f1e2d3c4b5a69";

describe("parseSshPublicKey", () => {
  it("reads the type, blob and comment of an ed25519 line", () => {
    const key = generateEd25519Key("alice@laptop");
    const parsed = parseSshPublicKey(key.line);

    expect(parsed.type).toBe("ssh-ed25519");
    expect(parsed.publicKey).toBe(key.publicKey);
    expect(parsed.comment).toBe("alice@laptop");
  });

  it("accepts RSA and ECDSA keys", () => {
    expect(parseSshPublicKey(generateRsaKey().line).type).toBe("ssh-rsa");
    expect(parseSshPublicKey(generateEcdsaKey().line).type).toBe("ecdsa-sha2-nistp256");
  });

  it("fingerprints the blob the way OpenSSH does", () => {
    const key = generateEd25519Key();
    const expected = createHash("sha256")
      .update(Buffer.from(key.publicKey, "base64"))
      .digest("base64")
      .replace(/=+$/, "");

    expect(parseSshPublicKey(key.line).fingerprint).toBe(`SHA256:${expected}`);
    expect(sshFingerprint(key.publicKey)).toBe(`SHA256:${expected}`);
  });

  it("tolerates surrounding whitespace and a missing comment", () => {
    const key = generateEd25519Key("");
    const parsed = parseSshPublicKey(`  ${key.line.trim()}\n`);

    expect(parsed.comment).toBe("");
    expect(parsed.publicKey).toBe(key.publicKey);
  });

  it("rejects a private key, prose, and unsupported key types", () => {
    expect(() => parseSshPublicKey("-----BEGIN OPENSSH PRIVATE KEY-----")).toThrow(
      SshKeyError,
    );
    expect(() => parseSshPublicKey("hello")).toThrow(SshKeyError);
    expect(() => parseSshPublicKey("ssh-dss AAAAB3NzaC1kc3M= me@host")).toThrow(
      /Unsupported key type/,
    );
  });

  it("rejects a line whose type disagrees with its blob", () => {
    const key = generateEd25519Key();
    const disguised = key.line.replace("ssh-ed25519", "ssh-rsa");

    expect(() => parseSshPublicKey(disguised)).toThrow(/does not match/);
  });

  it("rejects an RSA key too small to be a standing credential", () => {
    expect(() => parseSshPublicKey(generateRsaKey(1024).line)).toThrow(/2048/);
  });
});

describe("verifySshSignature", () => {
  it("accepts a signature over the challenge and names the signing key", () => {
    const key = generateEd25519Key();
    const verified = verifySshSignature({
      signature: key.sign(CHALLENGE),
      message: CHALLENGE,
    });

    expect(verified.publicKey).toBe(key.publicKey);
    expect(verified.fingerprint).toBe(parseSshPublicKey(key.line).fingerprint);
  });

  it("accepts RSA and ECDSA signatures", () => {
    const rsa = generateRsaKey();
    const ecdsa = generateEcdsaKey();

    expect(
      verifySshSignature({ signature: rsa.sign(CHALLENGE), message: CHALLENGE })
        .publicKey,
    ).toBe(rsa.publicKey);
    expect(
      verifySshSignature({ signature: ecdsa.sign(CHALLENGE), message: CHALLENGE })
        .publicKey,
    ).toBe(ecdsa.publicKey);
  });

  it("rejects the same signature over a different challenge", () => {
    const key = generateEd25519Key();

    expect(() =>
      verifySshSignature({ signature: key.sign(CHALLENGE), message: "another" }),
    ).toThrow(/does not match/);
  });

  /** The point of the namespace: a signature made for git is not a login. */
  it("rejects a signature made under another namespace", () => {
    const key = generateEd25519Key();

    expect(() =>
      verifySshSignature({
        signature: key.sign(CHALLENGE, { namespace: "git" }),
        message: CHALLENGE,
      }),
    ).toThrow(/namespace/);
  });

  it("rejects a signature whose bytes were tampered with", () => {
    const key = generateEd25519Key();
    const armored = key.sign(CHALLENGE);
    const body = armored.split("\n").slice(1, -2).join("");
    const blob = Buffer.from(body, "base64");
    blob[blob.length - 1] ^= 0xff;
    const tampered = [
      "-----BEGIN SSH SIGNATURE-----",
      ...(blob.toString("base64").match(/.{1,70}/g) ?? []),
      "-----END SSH SIGNATURE-----",
      "",
    ].join("\n");

    expect(() => verifySshSignature({ signature: tampered, message: CHALLENGE })).toThrow(
      SshKeyError,
    );
  });

  /** Swapping the advertised key does not make someone else's signature yours. */
  it("rejects a signature carrying a public key that did not make it", () => {
    const signer = generateEd25519Key();
    const other = generateEd25519Key();
    const armored = reattributeSignature(signer.sign(CHALLENGE), other.publicKey);

    expect(() => verifySshSignature({ signature: armored, message: CHALLENGE })).toThrow(
      SshKeyError,
    );
  });

  it("rejects SHA-1 signatures from an RSA key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
    const sshString = (value: string | Buffer) => {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      return Buffer.concat([length, body]);
    };
    const mpint = (value: Buffer) => {
      const trimmed = value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
      return sshString(trimmed);
    };
    const blob = Buffer.concat([
      sshString("ssh-rsa"),
      mpint(Buffer.from(jwk.e, "base64url")),
      mpint(Buffer.from(jwk.n, "base64url")),
    ]);
    const data = sshsigPreamble(
      "vektor-cli",
      "sha512",
      createHash("sha512").update(CHALLENGE).digest(),
    );

    const armored = sshsig({
      publicKey: blob,
      namespace: "vektor-cli",
      hashAlgorithm: "sha512",
      // "ssh-rsa" is the SHA-1 algorithm name; only rsa-sha2-* is accepted.
      signature: Buffer.concat([
        sshString("ssh-rsa"),
        sshString(sign("sha1", data, privateKey)),
      ]),
    });

    expect(() => verifySshSignature({ signature: armored, message: CHALLENGE })).toThrow(
      SshKeyError,
    );
  });

  it("rejects anything that is not an armored signature", () => {
    expect(() => verifySshSignature({ signature: "nope", message: CHALLENGE })).toThrow(
      /armored/,
    );
  });
});
