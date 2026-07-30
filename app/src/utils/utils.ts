export function normalizeTimestamp(value: string | number | Date): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "number") {
    return new Date(value < 1e12 ? value * 1000 : value);
  }

  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Invalid numeric timestamp: ${value}`);
    }
    return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed;
}

/** Inverse of `slugify` for display: "my-extension" → "My Extension". */
export function kebabToTitle(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function slugify(text: string) {
  const reservedSlugs = ["new"];

  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (reservedSlugs.includes(slug)) {
    slug = `${slug}-1`;
  }

  return slug;
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

/** Byte count as a short human label: "812 B", "3.4 KB", "1.2 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
