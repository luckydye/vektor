// Client-side file classification (does this `File` hold an image / video /
// audio?) plus the upload-URL absolutiser. Previously each upload site (canvas,
// editor image/video, header image, AI chat) carried its own copy of these
// checks with subtly different extension lists; centralising them keeps the
// behaviour consistent everywhere.
//
// Server-side upload path handling lives in `uploads.ts`; URL transform params
// in `transformUrl.ts`.

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

// 3D model formats the WebGPU preview (`<model-viewer-3d>`) can render.
export const MODEL_EXTENSIONS = ["obj", "gltf", "glb"];

function extensionOf(file: File): string {
  return file.name.split(".").pop()?.toLowerCase() ?? "";
}

export function isModelFile(file: File): boolean {
  return MODEL_EXTENSIONS.includes(extensionOf(file));
}

export function isModelSource(value: string | undefined): boolean {
  const ext = (value ?? "").split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  return MODEL_EXTENSIONS.includes(ext);
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

/**
 * Content type for a file extension, for the routes that serve stored bytes.
 *
 * Shared rather than per-route: an upload and a file read out of a repository
 * are the same question, and answering it differently in two places is how one
 * of them ends up serving `application/octet-stream` for a PNG.
 */
export const MIME_TYPES: Record<string, string> = {
  // Images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  // Videos
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
  // Documents
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  // Text
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  // Archive
  zip: "application/zip",
  // 3D models
  obj: "model/obj",
};

export function mimeTypeForExtension(extension: string | undefined): string {
  return (extension && MIME_TYPES[extension.toLowerCase()]) || "application/octet-stream";
}
