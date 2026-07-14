/**
 * Shared helpers for rendering audit-log / activity entries.
 * Used by activity feed components and RevisionsSidebar.vue.
 */

import type { AuditLog } from "#api/client.ts";
import { currentLang, t, type TranslationKey } from "#utils/lang.ts";
import {
  closeCircleIcon,
  documentIcon,
  documentTextIcon,
  editOutlineIcon,
  eyeIcon,
  infoIcon,
  lockIcon,
  plusSmallIcon,
  publishIcon,
  refreshIcon,
  trashCanIcon,
  unlockIcon,
} from "~/src/assets/icons.ts";
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

/**
 * Full-sentence description used in timeline views, e.g.
 * "Tim Havlicek - Document published"
 */
export function formatAuditEventDescription(userName: string, event: string): string {
  const descriptions: Record<string, string> = {
    view: `${userName} - Document viewed`,
    save: `${userName} - Document saved`,
    suggest: `${userName} - Suggested changes`,
    publish: `${userName} - Document published`,
    unpublish: `${userName} - Document unpublished`,
    restore: `${userName} - Revision restored`,
    delete: `${userName} - Document deleted`,
    acl_grant: `${userName} - Permission granted`,
    acl_revoke: `${userName} - Permission revoked`,
    create: `${userName} - Document created`,
    lock: `${userName} - Document locked`,
    unlock: `${userName} - Document unlocked`,
    archive: `${userName} - Document archived`,
    property_update: `${userName} - Property updated`,
    property_delete: `${userName} - Property deleted`,
  };
  return descriptions[event] ?? `${userName} - ${event}`;
}

// ---------------------------------------------------------------------------
// Event icons
// ---------------------------------------------------------------------------

/**
 * Returns an HTML string containing the icon for a given audit event type.
 * Intended for use with `v-html`.
 */
export function getAuditEventIcon(event: string): string {
  const icons: Record<string, string> = {
    revision: `<span class="svg-icon w-4 h-4 text-neutral-500">${documentIcon}</span>`,
    view: `<span class="svg-icon w-4 h-4 text-neutral-400">${eyeIcon}</span>`,
    publish: `<span class="svg-icon w-4 h-4 text-blue-500">${publishIcon}</span>`,
    unpublish: `<span class="svg-icon w-4 h-4 text-neutral-400">${publishIcon}</span>`,
    suggest: `<span class="svg-icon w-4 h-4 text-amber-500">${documentTextIcon}</span>`,
    restore: `<span class="svg-icon w-4 h-4 text-orange-500">${refreshIcon}</span>`,
    delete: `<span class="svg-icon w-4 h-4 text-red-500">${trashCanIcon}</span>`,
    archive: `<span class="svg-icon w-4 h-4 text-neutral-400">${trashCanIcon}</span>`,
    acl_grant: `<span class="svg-icon w-4 h-4 text-purple-500">${lockIcon}</span>`,
    acl_revoke: `<span class="svg-icon w-4 h-4 text-purple-500">${lockIcon}</span>`,
    create: `<span class="svg-icon w-4 h-4 text-green-500">${plusSmallIcon}</span>`,
    lock: `<span class="svg-icon w-4 h-4 text-yellow-500">${lockIcon}</span>`,
    unlock: `<span class="svg-icon w-4 h-4 text-green-500">${unlockIcon}</span>`,
    property_update: `<span class="svg-icon w-4 h-4 text-indigo-500">${editOutlineIcon}</span>`,
    property_delete: `<span class="svg-icon w-4 h-4 text-pink-500">${closeCircleIcon}</span>`,
  };
  return (
    icons[event] ?? `<span class="svg-icon w-4 h-4 text-neutral-400">${infoIcon}</span>`
  );
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
 * Formats a timestamp as a verbose relative-time string.
 * E.g. "just now", "5 minutes ago", "3 hours ago", "12 days ago".
 * Falls back to `toLocaleDateString()` for dates older than 30 days.
 */
export function formatActivityTime(dateString: string | Date): string {
  try {
    const date = normalizeTimestamp(dateString as string);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    const locale = currentLang();
    const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

    if (diffMins < 1) return relativeTime.format(0, "second");
    if (diffMins < 60) return relativeTime.format(-diffMins, "minute");
    if (diffHours < 24) return relativeTime.format(-diffHours, "hour");
    if (diffDays < 30) return relativeTime.format(-diffDays, "day");

    return date.toLocaleDateString(locale);
  } catch {
    return String(dateString);
  }
}
