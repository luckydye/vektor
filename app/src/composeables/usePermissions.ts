// Permission utility for checking user roles and feature access
//
// Usage examples:
//
// In Vue components:
// ```ts
// import { canAccessSettings, canComment, canViewHistory } from "../composeables/usePermissions.ts";
// import { computed } from "vue";
//
// const showSettingsButton = computed(() => {
//   return canAccessSettings(currentSpace.value?.userRole);
// });
//
// const showCommentButton = computed(() => {
//   return canComment(currentSpace.value?.userRole, currentSpace.value?.features);
// });
// ```
//
// For conditional rendering:
// ```vue
// <button v-if="canEdit(space.userRole)">Edit Document</button>
// <button v-if="canAccessSettings(space.userRole)">Settings</button>
// <button v-if="canComment(space.userRole, space.features)">Add Comment</button>
// ```

export type Permission = "owner" | "editor" | "viewer";

export type FeatureKey = "comment" | "view_history" | "view_audit" | "manage_extensions";

// Features that each permission level has by default (matches server-side DEFAULT_FEATURES)
const DEFAULT_FEATURES: Record<Permission, FeatureKey[]> = {
  owner: ["comment", "view_history", "view_audit", "manage_extensions"],
  editor: ["comment", "view_history"],
  viewer: [],
};

const PERMISSION_HIERARCHY: Record<Permission, number> = {
  owner: 3,
  editor: 2,
  viewer: 1,
};

/**
 * Check if a user role has at least the required permission level
 */
export function hasPermission(
  userRole: string | undefined,
  requiredPermission: Permission,
): boolean {
  if (!userRole) return false;

  const currentLevel = PERMISSION_HIERARCHY[userRole as Permission];
  const requiredLevel = PERMISSION_HIERARCHY[requiredPermission];

  if (currentLevel === undefined || requiredLevel === undefined) {
    return false;
  }

  return currentLevel >= requiredLevel;
}

/**
 * Check if user has access to a specific feature.
 * Features can be explicitly granted/denied via the features record,
 * or fall back to defaults based on permission level.
 *
 * @param userRole - The user's permission level (viewer, editor, owner)
 * @param feature - The feature to check
 * @param features - Optional explicit feature grants/denies from the API
 */
export function hasFeature(
  userRole: string | undefined,
  feature: FeatureKey,
  features?: Record<string, boolean>,
): boolean {
  // Check explicit feature grant/deny first
  if (features && feature in features) {
    return features[feature];
  }

  // Fall back to defaults based on permission level
  if (!userRole) return false;

  const defaultFeatures = DEFAULT_FEATURES[userRole as Permission];
  if (!defaultFeatures) return false;

  return defaultFeatures.includes(feature);
}

/**
 * Check if user can view (viewer, editor, or owner)
 */
export function canView(userRole: string | undefined): boolean {
  return hasPermission(userRole, "viewer");
}

/**
 * Check if user can edit (editor or owner)
 */
export function canEdit(userRole: string | undefined): boolean {
  return hasPermission(userRole, "editor");
}

/**
 * Check if user is owner
 */
export function isOwner(userRole: string | undefined): boolean {
  return userRole === "owner";
}

/**
 * Check if user can access settings (owner only)
 */
export function canAccessSettings(userRole: string | undefined): boolean {
  return isOwner(userRole);
}

/**
 * Check if user can comment on documents
 */
export function canComment(
  userRole: string | undefined,
  features?: Record<string, boolean>,
): boolean {
  return hasFeature(userRole, "comment", features);
}

/**
 * Check if user can view document history/revisions
 */
export function canViewHistory(
  userRole: string | undefined,
  features?: Record<string, boolean>,
): boolean {
  return hasFeature(userRole, "view_history", features);
}

/**
 * Check if user can view audit logs
 */
export function canViewAudit(
  userRole: string | undefined,
  features?: Record<string, boolean>,
): boolean {
  return hasFeature(userRole, "view_audit", features);
}

/**
 * Check if user can manage extensions
 */
export function canManageExtensions(
  userRole: string | undefined,
  features?: Record<string, boolean>,
): boolean {
  return hasFeature(userRole, "manage_extensions", features);
}
