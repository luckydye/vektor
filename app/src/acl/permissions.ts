/**
 * The permission vocabulary and every decision that can be made from a role
 * alone. Deliberately free of imports so both the ACL store (`#acl/store.ts`)
 * and the browser can use it — the client cannot reach the ACL table, but it
 * must reach the same verdict for the role the server handed it.
 */

export const ResourceType = {
  SPACE: "space",
  DOCUMENT: "document",
  DOCUMENT_TREE: "document_tree",
  CATEGORY: "category",
  EXTENSION: "extension",
  FEATURE: "feature",
} as const;

export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

/**
 * Roles and features are branded: at runtime they are the same strings the ACL
 * table and the API have always carried, but a bare `"editor"` is not
 * assignable to `Permission`. Callers must reference `Permission.EDITOR`, and a
 * value arriving from a request, a URL or a DB row has to pass `isPermission` /
 * `isFeature` before it can be used as one — which puts every trust boundary in
 * plain sight. (They cannot be real symbols: both are persisted in the `acl`
 * table and travel over JSON, neither of which a symbol survives.)
 */
declare const permissionBrand: unique symbol;
declare const featureBrand: unique symbol;

type PermissionName = "viewer" | "editor" | "owner";
type FeatureName = "comment" | "view_history" | "view_audit" | "manage_extensions";

export const Permission = {
  VIEWER: "viewer" as "viewer" & { readonly [permissionBrand]: true },
  EDITOR: "editor" as "editor" & { readonly [permissionBrand]: true },
  OWNER: "owner" as "owner" & { readonly [permissionBrand]: true },
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

// Feature-based permissions that can be granted/denied independently of role
export const Feature = {
  COMMENT: "comment" as "comment" & { readonly [featureBrand]: true },
  VIEW_HISTORY: "view_history" as "view_history" & { readonly [featureBrand]: true },
  VIEW_AUDIT: "view_audit" as "view_audit" & { readonly [featureBrand]: true },
  MANAGE_EXTENSIONS: "manage_extensions" as "manage_extensions" & {
    readonly [featureBrand]: true;
  },
} as const;

export type Feature = (typeof Feature)[keyof typeof Feature];

/**
 * Explicit per-feature grants, as resolved by the server and sent to the client.
 * Keyed by feature name rather than by the branded type: it is built from JSON.
 */
export type FeatureOverrides = Partial<Record<FeatureName, boolean>>;

/**
 * The synthetic group every caller belongs to, including unauthenticated ones.
 * A grant to it is what makes a space or document publicly readable.
 */
export const PUBLIC_GROUP = "public";

/**
 * An `acl.user_id` that is a credential's id rather than a person's. Ids carry
 * their type (`db/ids.ts`), and an account id from the IdP carries no underscore
 * at all, so the id alone says which it is.
 */
const CREDENTIAL_ID_PREFIXES = ["token_", "share_"];

export function isCredentialPrincipal(userId: string | null | undefined): boolean {
  return CREDENTIAL_ID_PREFIXES.some((prefix) => userId?.startsWith(prefix) ?? false);
}

/**
 * What credential a row carries, and so how its `secret` reads; null on an
 * ordinary grant. Editors mint links and owners mint tokens, so the two are told
 * apart on every read and write either side makes.
 */
export const AclKind = {
  TOKEN: "token",
  LINK: "link",
} as const;

export type AclKind = (typeof AclKind)[keyof typeof AclKind];

/**
 * Canonical shape of a group name. Group membership drives ACL access, so
 * every write AND read path must enforce this: it keeps LIKE wildcards
 * (`%`/`_`) and JSON-breaking characters out of stored group ids, and drops
 * malformed entries that bypassed the OAuth sanitizer.
 */
export const GROUP_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Identity used for per-resource ACL filtering; null = trusted system view. */
export interface AclViewer {
  userId: string;
  userGroups?: string[];
  /**
   * Documents this viewer may see, for a caller who holds no space-wide role
   * and reaches the space only through resource-scoped grants. Absent or null
   * means the space role is the floor — the normal case, where a document with
   * no ACL entry of its own is readable.
   */
  documentScope?: string[] | null;
}

// Keyed by every role name, not by string: a role added above without a rank
// here is a compile error rather than a grant that silently ranks below
// `viewer`. Indexed through `rankOf` because a branded value cannot index a
// record keyed by the plain names.
const PERMISSION_HIERARCHY: Record<PermissionName, number> = {
  viewer: 1,
  editor: 3,
  owner: 5,
};

// Features implied by a space permission level when no explicit feature ACL
// entry exists. Keyed by role name for the same reason as the hierarchy.
const DEFAULT_FEATURES: Record<PermissionName, Feature[]> = {
  owner: [
    Feature.COMMENT,
    Feature.VIEW_HISTORY,
    Feature.VIEW_AUDIT,
    Feature.MANAGE_EXTENSIONS,
  ],
  editor: [Feature.COMMENT, Feature.VIEW_HISTORY, Feature.VIEW_AUDIT],
  viewer: [],
};

/** The one place a role name is read out of the rank table. */
function rankOf(name: PermissionName): number {
  return PERMISSION_HIERARCHY[name];
}

/** Whether `value` is one of the grantable roles — the gate on role input from a request. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && Object.hasOwn(PERMISSION_HIERARCHY, value);
}

/** Whether `value` is one of the grantable features — the gate on feature input from a request. */
export function isFeature(value: unknown): value is Feature {
  return (
    typeof value === "string" && (Object.values(Feature) as string[]).includes(value)
  );
}

export function isResourceType(value: unknown): value is ResourceType {
  return (
    typeof value === "string" && (Object.values(ResourceType) as string[]).includes(value)
  );
}

/** The grantable roles, weakest first. For validation messages and pickers. */
export function allPermissions(): Permission[] {
  return (Object.keys(PERMISSION_HIERARCHY) as PermissionName[])
    .sort((a, b) => rankOf(a) - rankOf(b))
    .map((name) => name as unknown as Permission);
}

/** The grantable features. For validation messages and pickers. */
export function allFeatures(): Feature[] {
  return Object.values(Feature);
}

/** Rank of a permission. Unknown or absent ranks 0 so it never outranks a real grant. */
export function permissionLevel(permission: string | undefined): number {
  return isPermission(permission) ? rankOf(permission as unknown as PermissionName) : 0;
}

/**
 * The item whose role ranks highest, or undefined when there are none. A user
 * can hold several grants on one resource — their own plus one per group — and
 * `hasPermission` lets the strongest decide, so everything reporting or
 * delegating a role resolves it through here to agree with that.
 */
export function strongestGrant<T>(
  items: Iterable<T>,
  permissionOf: (item: T) => string | undefined,
): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (
      best === undefined ||
      permissionLevel(permissionOf(item)) > permissionLevel(permissionOf(best))
    ) {
      best = item;
    }
  }
  return best;
}

/** The weaker of two roles. */
export function weakerPermission<T extends string | undefined>(a: T, b: T): T {
  return permissionLevel(a) <= permissionLevel(b) ? a : b;
}

/** As above, for role names: a feature grant or a typo never wins. */
export function highestPermission(
  permissions: Iterable<string | undefined>,
): Permission | undefined {
  const roles = [...permissions].filter(isPermission);
  return strongestGrant(roles, (role) => role);
}

/** Permission names ranking at or above `minPermission`, for ACL queries filtering by level. */
export function permissionsAtLeast(minPermission: string): string[] {
  const min = permissionLevel(minPermission);
  return Object.entries(PERMISSION_HIERARCHY)
    .filter(([, level]) => level >= min)
    .map(([permission]) => permission);
}

export function meetsPermissionLevel(
  userPermission: string | undefined,
  requiredPermission: Permission,
): boolean {
  // Fail closed when an untyped caller passes a non-role. Otherwise the required
  // level would be 0 and every user would clear it (this is exactly how a typo'd
  // role like "admin" silently became a no-op gate).
  if (!isPermission(requiredPermission)) {
    return false;
  }

  return permissionLevel(userPermission) >= permissionLevel(requiredPermission);
}

/**
 * Whether a role has a feature. `overrides` carries explicit grants/denies read
 * from the ACL — an entry there wins over the role default, in both directions.
 */
export function resolveFeature(
  role: string | undefined,
  feature: Feature,
  overrides?: FeatureOverrides,
): boolean {
  if (!role) return false;
  const override = overrides?.[feature as unknown as FeatureName];
  if (override !== undefined) return override;
  if (!isPermission(role)) return false;
  return DEFAULT_FEATURES[role as unknown as PermissionName].includes(feature);
}

export function isOwner(role: string | undefined): boolean {
  return role === Permission.OWNER;
}

export function canView(role: string | undefined): boolean {
  return meetsPermissionLevel(role, Permission.VIEWER);
}

export function canEdit(role: string | undefined): boolean {
  return meetsPermissionLevel(role, Permission.EDITOR);
}

export function canAccessSettings(role: string | undefined): boolean {
  return isOwner(role);
}

export function canComment(
  role: string | undefined,
  overrides?: FeatureOverrides,
): boolean {
  return resolveFeature(role, Feature.COMMENT, overrides);
}

export function canViewHistory(
  role: string | undefined,
  overrides?: FeatureOverrides,
): boolean {
  return resolveFeature(role, Feature.VIEW_HISTORY, overrides);
}

export function canViewAudit(
  role: string | undefined,
  overrides?: FeatureOverrides,
): boolean {
  return resolveFeature(role, Feature.VIEW_AUDIT, overrides);
}

export function canManageExtensions(
  role: string | undefined,
  overrides?: FeatureOverrides,
): boolean {
  return resolveFeature(role, Feature.MANAGE_EXTENSIONS, overrides);
}
