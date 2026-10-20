const SAFE_UPLOAD_ID_PART = /^[a-zA-Z0-9_-]+$/;
const SAFE_UPLOAD_PATH_PART = /^[a-zA-Z0-9._-]+$/;

export function isSafeUploadIdPart(value: string): boolean {
  return SAFE_UPLOAD_ID_PART.test(value);
}

export function isSafeUploadPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\")) {
    return false;
  }

  return value
    .split("/")
    .every((part) => part !== "." && part !== ".." && SAFE_UPLOAD_PATH_PART.test(part));
}

/**
 * Extract the storage key from an internal upload URL, e.g.
 * "/api/v1/spaces/{spaceId}/uploads/ab/abc123.png" -> "ab/abc123.png".
 * Returns null for external URLs, other spaces' uploads, and unsafe keys.
 */
export function uploadKeyFromUrl(
  spaceId: string,
  url: string | undefined,
): string | null {
  if (!url) return null;

  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return null;
  }

  const prefix = `/api/v1/spaces/${encodeURIComponent(spaceId)}/uploads/`;
  if (!pathname.startsWith(prefix)) return null;

  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  return isSafeUploadPath(key) ? key : null;
}
