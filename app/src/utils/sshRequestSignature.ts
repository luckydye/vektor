/**
 * The `SSH-SIG` HTTP authentication scheme: what a signed request signs, and how
 * the signature travels.
 *
 *   Authorization: SSH-SIG t=<unix seconds>,n=<nonce>,s=<base64 armored SSHSIG>
 *
 * The signed string names the one request it belongs to — method, path, body
 * digest — plus a timestamp and a nonce, so a captured signature cannot be
 * replayed against a different call, a different body, or the same call twice.
 * The CLI builds it to sign and the server rebuilds it to verify; keeping both
 * in one file is what makes them agree.
 */

import { createHash } from "node:crypto";

export const SSH_AUTH_SCHEME = "SSH-SIG";

/** Signed as the first line, so a later scheme cannot be read as this one. */
export const SSH_CANONICAL_VERSION = "VEKTOR-SSH-V1";

/** The SSHSIG namespace: a signature made for anything else will not verify. */
export const SSH_SIGNATURE_NAMESPACE = "vektor-cli";

export interface SignedRequestParts {
  method: string;
  /** Path and query, exactly as sent — `/api/v1/spaces?limit=10`. */
  path: string;
  body: Uint8Array | string;
  /** Unix seconds. */
  timestamp: number;
  nonce: string;
}

export function sha256Hex(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function canonicalRequest(parts: SignedRequestParts): string {
  return [
    SSH_CANONICAL_VERSION,
    parts.method.toUpperCase(),
    parts.path,
    sha256Hex(parts.body),
    String(parts.timestamp),
    parts.nonce,
  ].join("\n");
}

/** The armored signature is base64'd again: SSHSIG's own armor spans lines. */
export function formatAuthorization(options: {
  timestamp: number;
  nonce: string;
  signature: string;
}): string {
  const signature = Buffer.from(options.signature, "utf8").toString("base64");
  return `${SSH_AUTH_SCHEME} t=${options.timestamp},n=${options.nonce},s=${signature}`;
}

export function isSshSignedAuthorization(authorization: string | null): boolean {
  return authorization?.startsWith(`${SSH_AUTH_SCHEME} `) === true;
}

export interface ParsedAuthorization {
  timestamp: number;
  nonce: string;
  /** The armored SSHSIG, decoded back to its multi-line form. */
  signature: string;
}

export function parseAuthorization(
  authorization: string | null,
): ParsedAuthorization | undefined {
  if (!isSshSignedAuthorization(authorization) || !authorization) return undefined;

  const parameters = new Map<string, string>();
  for (const part of authorization.slice(SSH_AUTH_SCHEME.length + 1).split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    parameters.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }

  const timestamp = Number(parameters.get("t"));
  const nonce = parameters.get("n");
  const signature = parameters.get("s");
  if (!Number.isInteger(timestamp) || !nonce || !signature) return undefined;

  return {
    timestamp,
    nonce,
    signature: Buffer.from(signature, "base64").toString("utf8"),
  };
}
