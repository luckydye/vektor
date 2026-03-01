import { createHash, randomBytes } from "node:crypto";

export function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createOAuthState(): string {
  return toBase64Url(randomBytes(24));
}

export function createPkceCodeVerifier(): string {
  return toBase64Url(randomBytes(48));
}

export function createPkceCodeChallenge(codeVerifier: string): string {
  return toBase64Url(createHash("sha256").update(codeVerifier).digest());
}

export function normalizeRedirectPath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const path = value.trim();
  if (!path.startsWith("/")) {
    return null;
  }
  if (path.startsWith("//")) {
    return null;
  }

  return path;
}

export function appendQueryParams(path: string, params: Record<string, string>): string {
  const [pathname, existingQuery = ""] = path.split("?", 2);
  const query = new URLSearchParams(existingQuery);

  for (const [key, value] of Object.entries(params)) {
    query.set(key, value);
  }

  const queryString = query.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}
