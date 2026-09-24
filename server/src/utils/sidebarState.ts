export const SIDEBAR_WIDTH_KEY = "sidebar-width";
export const DEFAULT_SIDEBAR_WIDTH = 280;
export const MIN_SIDEBAR_WIDTH = 76;
export const MAX_SIDEBAR_WIDTH = 500;

export function parseSidebarWidth(
  value: string | number | null | undefined,
  fallback = DEFAULT_SIDEBAR_WIDTH,
) {
  const width = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(width)) return fallback;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
}

export function writeSidebarWidthCookie(width: number) {
  // biome-ignore lint/suspicious/noDocumentCookie: Synchronous cookie write is needed so the next server render sees the sidebar width.
  document.cookie = `${SIDEBAR_WIDTH_KEY}=${encodeURIComponent(
    String(parseSidebarWidth(width)),
  )}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}
