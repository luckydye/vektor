type Permission = "owner" | "editor" | "viewer";

const PERMISSION_HIERARCHY: Record<Permission, number> = {
  owner: 3,
  editor: 2,
  viewer: 1,
};

function hasPermission(
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

export function canEdit(userRole: string | undefined): boolean {
  return hasPermission(userRole, "editor");
}

function isOwner(userRole: string | undefined): boolean {
  return userRole === "owner";
}

export function canAccessSettings(userRole: string | undefined): boolean {
  return isOwner(userRole);
}
