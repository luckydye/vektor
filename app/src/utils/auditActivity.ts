/**
 * Shared helpers for rendering audit-log / activity entries.
 * Used by activity feed components and RevisionsSidebar.vue.
 */

import type { AuditLog } from "#api/client.ts";
import { currentLang, type TranslationKey, t } from "#utils/lang.ts";
import { formatRelativeTime, normalizeTimestamp } from "./utils.ts";

// ---------------------------------------------------------------------------
// Event labels
// ---------------------------------------------------------------------------

/**
 * Short verb form shown as the action in an activity entry header.
 * E.g. "Published", "Edited", "Created".
 */
const auditEventLabels: Record<string, TranslationKey> = {
  view: "Viewed",
  comment: "Commented",
  save: "Edited",
  suggest: "Suggested",
  publish: "Published",
  unpublish: "Unpublished",
  restore: "Restored",
  delete: "Deleted",
  create: "Created",
  lock: "Locked",
  unlock: "Unlocked",
  archive: "Archived",
  property_update: "Updated",
  property_delete: "Updated",
};

export function getAuditEventLabel(event: string): string {
  const key = auditEventLabels[event];
  return key ? t(key) : event;
}

const auditEventActionKeys: Record<string, TranslationKey> = {
  comment: "commented",
  publish: "published",
  unpublish: "unpublished",
  delete: "deleted",
  archive: "archived",
  create: "created",
  restore: "restored",
  lock: "locked",
  unlock: "unlocked",
  save: "edited",
  suggest: "suggested",
  property_update: "edited",
  property_delete: "edited",
};

export function getAuditEventAction(event: string): string {
  const key = auditEventActionKeys[event];
  return key ? t(key) : getAuditEventLabel(event).toLocaleLowerCase(currentLang());
}

// ---------------------------------------------------------------------------
// Property changes
// ---------------------------------------------------------------------------

/** Returns true when the entry carries a property-change payload. */
export function hasPropertyChange(activity: AuditLog): boolean {
  return (
    (activity.event === "property_update" || activity.event === "property_delete") &&
    !!activity.details?.propertyKey
  );
}

/**
 * Converts a property key (snake_case or camelCase) to a human-readable
 * "Title Case" label. E.g. "due_date" → "Due Date".
 */
export function formatPropertyKey(key?: string): string {
  if (!key) return t("Property");
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/**
 * Verbose relative time for an activity entry: "5 minutes ago", "3 hours ago",
 * "12 days ago", falling back to an absolute date past 30 days.
 */
export function formatActivityTime(dateString: string | Date): string {
  return formatRelativeTime(dateString, { maxDays: 30 });
}

/** Full day heading an activity group is bucketed under. */
export function getActivityDate(dateString: string | Date): string {
  return normalizeTimestamp(dateString as string).toLocaleDateString(currentLang(), {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Label for a day bucket in an activity feed: the relative time for entries
 * from today, then "Yesterday", the weekday within the last week, and a short
 * date beyond that (with the year only when it is not the current one).
 */
export function getActivityBucketLabel(dateString: string | Date): string {
  try {
    const date = normalizeTimestamp(dateString as string);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor(
      (startOfToday.getTime() - startOfDate.getTime()) / 86400000,
    );

    if (diffDays === 0) return formatActivityTime(date);
    if (diffDays === 1) return t("Yesterday");
    if (diffDays < 7) return date.toLocaleDateString(currentLang(), { weekday: "long" });
    return date.toLocaleDateString(currentLang(), {
      month: "short",
      day: "numeric",
      year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
  } catch {
    return String(dateString);
  }
}
