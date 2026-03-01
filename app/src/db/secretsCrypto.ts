import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.ts";

type EncryptedValue = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

const ALGO = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const configured = config().SECRETS_ENCRYPTION_KEY?.trim();

  if (configured) {
    const base64 = Buffer.from(configured, "base64");
    if (base64.length === 32) {
      return base64;
    }

    const utf8 = Buffer.from(configured, "utf8");
    if (utf8.length === 32) {
      return utf8;
    }

    throw new Error("WIKI_SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  const fallback = config().AUTH_SECRET?.trim();
  if (!fallback) {
    throw new Error("AUTH_SECRET (or WIKI_SECRETS_ENCRYPTION_KEY) must be configured");
  }

  return createHash("sha256").update(fallback).digest();
}

export function encryptSecret(value: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptSecret(value: EncryptedValue): string {
  const decipher = createDecipheriv(
    ALGO,
    getEncryptionKey(),
    Buffer.from(value.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(value.authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
