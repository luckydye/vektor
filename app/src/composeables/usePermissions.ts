type Permission = "owner" | "editor" | "viewer";
type Feature = "comment" | "view_history" | "view_audit" | "manage_extensions";
type FeatureOverrides = Partial<Record<Feature, boolean>>;

const PERMISSION_HIERARCHY: Record<Permission, number> = {
  owner: 3,
  editor: 2,
  viewer: 1,
};

const FEATURE_DEFAULTS: Record<Permission, Record<Feature, boolean>> = {
  owner: { comment: true, view_history: true, view_audit: true, manage_extensions: true },
  editor: {
    comment: true,
    view_history: true,
    view_audit: true,
    manage_extensions: false,
  },
  viewer: {
    comment: false,
    view_history: false,
    view_audit: false,
    manage_extensions: false,
  },
};

export function hasPermission(
  userRole: string | undefined,
  requiredPermission: Permission,
): boolean {
  if (!userRole) return false;
  const currentLevel = PERMISSION_HIERARCHY[userRole as Permission];
  const requiredLevel = PERMISSION_HIERARCHY[requiredPermission];
  if (currentLevel === undefined || requiredLevel === undefined) return false;
  return currentLevel >= requiredLevel;
}

export function isOwner(userRole: string | undefined): boolean {
  return userRole === "owner";
}

export function canView(userRole: string | undefined): boolean {
  return hasPermission(userRole, "viewer");
}

export function canEdit(userRole: string | undefined): boolean {
  return hasPermission(userRole, "editor");
}

export function canAccessSettings(userRole: string | undefined): boolean {
  return isOwner(userRole);
}

export function hasFeature(
  userRole: string | undefined,
  feature: Feature,
  overrides?: FeatureOverrides,
): boolean {
  if (!userRole) return false;
  if (overrides && feature in overrides) return overrides[feature]!;
  const defaults = FEATURE_DEFAULTS[userRole as Permission];
  if (!defaults) return false;
  return defaults[feature];
}

export function canComment(
  userRole: string | undefined,
  overrides?: FeatureOverrides,
): boolean {
  return hasFeature(userRole, "comment", overrides);
}

export function canViewHistory(
  userRole: string | undefined,
  overrides?: FeatureOverrides,
): boolean {
  return hasFeature(userRole, "view_history", overrides);
}

export function canViewAudit(
  userRole: string | undefined,
  overrides?: FeatureOverrides,
): boolean {
  return hasFeature(userRole, "view_audit", overrides);
}

export function canManageExtensions(
  userRole: string | undefined,
  overrides?: FeatureOverrides,
): boolean {
  return hasFeature(userRole, "manage_extensions", overrides);
}
