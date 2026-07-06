// Shared file classification and upload-URL helpers. Previously each upload
// site (canvas, editor image/video, header image, AI chat) carried its own
// copy of these checks with subtly different extension lists; centralising
// them keeps the behaviour consistent everywhere.

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
export const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "m4v", "avi", "mkv", "ogv", "ogg"];
export const VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/ogg",
];

function extensionOf(file: File): string {
  return file.name.split(".").pop()?.toLowerCase() ?? "";
}

export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.includes(extensionOf(file));
}

export function isVideoFile(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  if (VIDEO_MIME_TYPES.includes(file.type)) return true;
  return VIDEO_EXTENSIONS.includes(extensionOf(file));
}

export function isMediaFile(file: File): boolean {
  return isVideoFile(file) || isImageFile(file);
}

export function mediaTypeForFile(file: File): "image" | "video" | null {
  if (isVideoFile(file)) return "video";
  if (isImageFile(file)) return "image";
  return null;
}

// Uploads return a path (e.g. "/api/...") or an absolute URL. Some surfaces
// (the canvas, which persists the src into Yjs) need an absolute URL; others
// can use the value as-is.
export function toAbsoluteUploadUrl(url: string): string {
  if (!url) return url;
  return url.startsWith("/") ? `${window.location.origin}${url}` : url;
}
