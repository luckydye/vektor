/**
 * Shared helpers for rendering audit-log / activity entries.
 * Used by activity feed components and RevisionsSidebar.vue.
 */

import type { AuditLog } from "#api/client.ts";
import { formatRelativeTime } from "./datetime.ts";
import { currentLang, type TranslationKey, t } from "./lang.ts";
import { normalizeTimestamp } from "./utils.ts";

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
  acl_grant: "Access granted",
  acl_revoke: "Access removed",
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
  acl_grant: "changed access",
  acl_revoke: "changed access",
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
// Permission changes
// ---------------------------------------------------------------------------

/** Returns true when the entry describes a permission (ACL) change. */
export function isPermissionEvent(event: string): boolean {
  return event === "acl_grant" || event === "acl_revoke";
}

/**
 * Who a permission change applied to. Prefers the name captured when the
 * change was made, so removed members still render with a name.
 */
export function getPermissionTargetName(activity: AuditLog): string {
  const details = activity.details;
  return (
    details?.targetName ||
    details?.targetGroupId ||
    details?.targetUserId ||
    t("Unknown user")
  );
}

/**
 * Change label for a permission entry, e.g. "Invited: Jane Doe (editor)",
 * "Role changed: Jane Doe (viewer → editor)" or "Access removed: Jane Doe".
 */
export function getPermissionChangeLabel(activity: AuditLog): string | null {
  if (!isPermissionEvent(activity.event)) return null;

  const details = activity.details ?? {};
  const name = getPermissionTargetName(activity);

  if (activity.event === "acl_revoke") {
    return `${t("Access removed")}: ${name}`;
  }

  // Feature overrides carry the feature name rather than a role.
  if (details.resourceType === "feature") {
    const feature = formatPropertyKey(details.resourceId);
    const granted = details.permission !== "denied";
    return `${granted ? t("Access granted") : t("Access denied")}: ${name} (${feature})`;
  }

  const verb = details.resourceType === "space" ? t("Invited") : t("Access granted");

  if (details.previousValue) {
    return `${t("Role changed")}: ${name} (${details.previousValue} → ${details.permission})`;
  }

  return details.permission
    ? `${verb}: ${name} (${details.permission})`
    : `${verb}: ${name}`;
}

/**
 * What actually changed in an entry, shown next to the action. Permission and
 * property edits describe themselves; everything else falls back to a fixed
 * label per event, and `null` means the event has nothing to add beyond its
 * action verb.
 */
export function getEntryChangeLabel(entry: AuditLog): string | null {
  if (isPermissionEvent(entry.event)) return getPermissionChangeLabel(entry);
  if (hasPropertyChange(entry)) return formatPropertyKey(entry.details?.propertyKey);

  const labels: Record<string, string> = {
    save: t("Content"),
    publish: t("Page published"),
    unpublish: t("Page unpublished"),
    create: t("Page created"),
    delete: t("Page deleted"),
    archive: t("Page archived"),
    restore: t("Page restored"),
    lock: t("Page locked"),
    unlock: t("Page unlocked"),
  };

  return labels[entry.event] ?? null;
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

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

    // Verbose relative time for today's entries; older buckets get a date.
    if (diffDays === 0) return formatRelativeTime(date, { maxDays: 30 });
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
