import { t } from "#utils/lang.ts";

/** Inverse of `slugify` for display: "my-extension" → "My Extension". */
export function kebabToTitle(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function detectAppType(
  label: string,
): "jira" | "youtrack" | "linear" | "github" | "gitlab" | undefined {
  const lowerLabel = label.toLowerCase();

  if (lowerLabel.includes("jira")) {
    return "jira";
  }
  if (lowerLabel.includes("youtrack")) {
    return "youtrack";
  }
  if (lowerLabel.includes("linear")) {
    return "linear";
  }
  if (lowerLabel.includes("github")) {
    return "github";
  }
  if (lowerLabel.includes("gitlab")) {
    return "gitlab";
  }

  return undefined;
}

/**
 * Build a full space-scoped URL from a base-relative path (e.g. "/doc/foo").
 * The router base is "/{spaceSlug}/", so anchor `href` attributes must include
 * the space slug for middle-click / open-in-new-tab to resolve on the server.
 */
export function spacePath(spaceSlug: string | null | undefined, path: string): string {
  if (!spaceSlug) return path;
  return `/${spaceSlug}${path.startsWith("/") ? path : `/${path}`}`;
}

/** A space's member count as a label: "1 Member", "12 Members". */
export function memberCountLabel(count: number | undefined): string {
  const members = count ?? 0;
  return `${members} ${members === 1 ? t("Member") : t("Members")}`;
}

/** Byte count as a short human label: "812 B", "3.4 KB", "1.2 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
