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
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "oga", "opus"];
export const AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/ogg",
  "audio/opus",
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

export function isAudioFile(file: File): boolean {
  if (file.type.startsWith("audio/")) return true;
  if (AUDIO_MIME_TYPES.includes(file.type)) return true;
  return AUDIO_EXTENSIONS.includes(extensionOf(file));
}

export function isMediaFile(file: File): boolean {
  return isVideoFile(file) || isImageFile(file) || isAudioFile(file);
}

export function mediaTypeForFile(file: File): "image" | "video" | "audio" | null {
  // Audio mime types win over the video extension list so `.ogg`/`.oga`
  // audio (an extension shared with video containers) is not misread as video.
  if (file.type.startsWith("audio/")) return "audio";
  if (isVideoFile(file)) return "video";
  if (isImageFile(file)) return "image";
  if (isAudioFile(file)) return "audio";
  return null;
}

// Uploads return a path (e.g. "/api/...") or an absolute URL. Some surfaces
// (the canvas, which persists the src into Yjs) need an absolute URL; others
// can use the value as-is.
export function toAbsoluteUploadUrl(url: string): string {
  if (!url) return url;
  return url.startsWith("/") ? `${window.location.origin}${url}` : url;
}
