import { resolve } from "node:path";

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

export function getUploadsRoot(spaceId: string): string {
  return resolve(process.cwd(), "data", "uploads", spaceId);
}

export function isWithinUploadsRoot(spaceId: string, targetPath: string): boolean {
  const uploadsRoot = getUploadsRoot(spaceId);
  const resolved = resolve(targetPath);
  return resolved === uploadsRoot || resolved.startsWith(`${uploadsRoot}/`);
}
