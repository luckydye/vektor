/**
 * Writing a role grant, as a domain operation.
 *
 * Who may hand out which role has to be decided inside the same transaction as
 * the write it gates, or the role the caller is checked against is not the one
 * the write displaces. So the rules answer with a {@link RoleWriteResult}, and
 * the route turns that into a status code.
 */

import { resolveGranteeName } from "#acl/directory.ts";
import {
  highestPermission,
  meetsPermissionLevel,
  Permission,
  permissionLevel,
  ResourceType,
} from "#acl/permissions.ts";
import {
  type AclEntry,
  grantPermission,
  listPermissions,
  revokePermission,
} from "#acl/store.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";

/** Who a role is being written for: exactly one of the two. */
export interface RoleGrantee {
  userId?: string;
  groupId?: string;
}

/** What {@link writeRolePermission} was asked to do, and by whom. */
export interface RoleWrite {
  spaceId: string;
  resourceType: ResourceType;
  resourceId: string;
  grantee: RoleGrantee;
  /** The role to leave behind, or `undefined` to revoke. */
  role: Permission | undefined;
  actorUserId: string;
  /** Whether the actor holds `owner` on the space, decided before the write. */
  actorIsOwner: boolean;
}

/**
 * The outcome of a role write. The two refusals are decisions the transaction
 * reached, not errors: `needs-owner` is a 403 and `last-owner` a 400, but that
 * translation belongs to whoever is answering a request.
 */
export type RoleWriteResult =
  | { outcome: "granted"; entry: AclEntry }
  | { outcome: "revoked" }
  | { outcome: "needs-owner" }
  | { outcome: "last-owner" };

// Space scope is absent on purpose: who the space admits is space-wide
// configuration, next to renaming and deletion, so it stays owner-only.
const EDITOR_DELEGABLE_SCOPES: readonly ResourceType[] = [
  ResourceType.DOCUMENT,
  ResourceType.DOCUMENT_TREE,
  ResourceType.CATEGORY,
];

const EDITOR_WITHDRAWABLE_SCOPES: readonly ResourceType[] = [
  ResourceType.DOCUMENT,
  ResourceType.DOCUMENT_TREE,
];

async function currentRoleOnResource(
  resourceType: ResourceType,
  resourceId: string,
  grantee: RoleGrantee,
  store: SpaceStore,
): Promise<Permission | undefined> {
  const entries = await listPermissions(store, resourceType, resourceId);
  return highestPermission(
    entries
      .filter(
        (entry) =>
          (grantee.userId && entry.userId === grantee.userId && !entry.groupId) ||
          (grantee.groupId && entry.groupId === grantee.groupId && !entry.userId),
      )
      .map((entry) => entry.permission),
  );
}

async function requiredRoleForRoleWrite(
  resourceType: ResourceType,
  resourceId: string,
  grantee: RoleGrantee,
  role: Permission | undefined,
  store: SpaceStore,
): Promise<Permission> {
  if (meetsPermissionLevel(role, Permission.OWNER)) {
    return Permission.OWNER;
  }

  if (!EDITOR_DELEGABLE_SCOPES.includes(resourceType)) {
    return Permission.OWNER;
  }

  // A group is a class of people the space admits, not a per-resource share —
  // the synthetic `public` group most of all. Owners decide who is in reach.
  if (grantee.groupId) {
    return Permission.OWNER;
  }

  const displaced = await currentRoleOnResource(resourceType, resourceId, grantee, store);

  if (meetsPermissionLevel(displaced, Permission.OWNER)) {
    return Permission.OWNER;
  }

  const withdraws =
    !role ||
    (displaced !== undefined && permissionLevel(role) < permissionLevel(displaced));
  if (withdraws && !EDITOR_WITHDRAWABLE_SCOPES.includes(resourceType)) {
    return Permission.OWNER;
  }

  return Permission.EDITOR;
}

/** Whether this write would leave the space without an owner. */
async function removesLastOwner(
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  grantee: RoleGrantee,
  resultingRole: Permission | undefined,
  store: SpaceStore,
): Promise<boolean> {
  if (
    resourceType !== ResourceType.SPACE ||
    resourceId !== spaceId ||
    resultingRole === Permission.OWNER
  ) {
    return false;
  }

  const ownerEntries = (await listPermissions(store, ResourceType.SPACE, spaceId)).filter(
    (entry) => entry.permission === Permission.OWNER && !entry.kind,
  );
  const targetsOwner = (entry: (typeof ownerEntries)[number]) => {
    if (resultingRole === undefined) {
      return (
        (grantee.userId === undefined || entry.userId === grantee.userId) &&
        (grantee.groupId === undefined || entry.groupId === grantee.groupId)
      );
    }
    if (grantee.userId !== undefined) {
      return entry.userId === grantee.userId && entry.groupId === undefined;
    }
    return entry.groupId === grantee.groupId && entry.userId === undefined;
  };

  return ownerEntries.some(targetsOwner) && ownerEntries.every(targetsOwner);
}

/**
 * Grant or revoke a role, deciding inside the transaction whether the actor may:
 * an editor may reshare a document but not touch a grant that outranks their
 * own, and a space must keep an owner. A refusal returns before any write.
 */
export async function writeRolePermission(write: RoleWrite): Promise<RoleWriteResult> {
  const store = await openSpaceStore(write.spaceId);

  return store.tx(async (transaction) => {
    const requiredRole = await requiredRoleForRoleWrite(
      write.resourceType,
      write.resourceId,
      write.grantee,
      write.role,
      transaction,
    );
    if (requiredRole === Permission.OWNER && !write.actorIsOwner) {
      return { outcome: "needs-owner" };
    }

    if (
      await removesLastOwner(
        write.spaceId,
        write.resourceType,
        write.resourceId,
        write.grantee,
        write.role,
        transaction,
      )
    ) {
      return { outcome: "last-owner" };
    }

    if (write.role) {
      const entry = await grantPermission(
        transaction,
        write.resourceType,
        write.resourceId,
        write.grantee.userId,
        write.role,
        write.grantee.groupId,
        write.actorUserId,
        await resolveGranteeName(write.grantee.userId),
      );
      return { outcome: "granted", entry };
    }

    await revokePermission(
      transaction,
      write.resourceType,
      write.resourceId,
      write.grantee.userId,
      write.grantee.groupId,
      write.actorUserId,
      await resolveGranteeName(write.grantee.userId),
    );
    return { outcome: "revoked" };
  });
}
