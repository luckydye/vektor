import { inArray } from "drizzle-orm";
import { getGroupMemberIds, getSpaceMembersWithGroups } from "#acl/directory.ts";
import { canAccess, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { getResourceScopedGrantees, listPermissions } from "#acl/store.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getAuthDb } from "#db/client/db.ts";
import { many } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { user as userTable } from "#db/schema/auth.ts";
import { resolveProfileImage } from "#utils/gravatar.ts";

/**
 * List the members of a space with their roles
 *
 * @tag Spaces
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.var.params, "spaceId");

      await verifyAccess(
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        user.id,
        Permission.VIEWER,
      );

      // Member email addresses are PII: only expose them to editors/owners
      // (who need them e.g. for mentions); plain viewers get id/name/image.
      const canSeeEmails = await canAccess(
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        user.id,
        Permission.EDITOR,
      );

      const store = await openSpaceStore(spaceId);
      const permissions = await listPermissions(store, ResourceType.SPACE, spaceId);
      const { directUserIds, groupMembers } = await getSpaceMembersWithGroups(spaceId);

      // Users who only hold a document/tree/category grant (no space-wide
      // role) still need to resolve to a name/avatar wherever this endpoint
      // is used to look up "who is userId X" — comments, revisions,
      // mentions, the members table itself. A group grant on a category is one
      // such grant for everyone in the group, so it is expanded like the
      // space-level ones.
      const resourceScoped = await getResourceScopedGrantees(spaceId);
      const resourceScopedUserIds = new Set([
        ...resourceScoped.userIds,
        ...(await getGroupMemberIds([...resourceScoped.groupIds])),
      ]);

      // Fetch user data for all members
      const authDb = getAuthDb();
      const allUserIds = [
        ...new Set([...directUserIds, ...groupMembers.keys(), ...resourceScopedUserIds]),
      ];
      const users = await many(
        authDb.select().from(userTable).where(inArray(userTable.id, allUserIds)),
      );

      const userMap = new Map(users.map((u) => [u.id, u]));

      // Add direct user permissions
      const members = permissions
        // A token holds a space grant but is a credential a member issued, not
        // a member — and it is listed with the rest of the access elsewhere.
        .filter((p) => p.userId && !p.groupId && !p.kind)
        .map((p) => {
          const userData = p.userId ? userMap.get(p.userId) : undefined;

          return {
            spaceId: p.resourceId,
            userId: p.userId,
            groupId: p.groupId,
            role: p.permission,
            joinedAt: p.createdAt,
            user: userData
              ? {
                  id: userData.id,
                  name: userData.name,
                  email: canSeeEmails ? userData.email : undefined,
                  image: resolveProfileImage(userData),
                }
              : undefined,
          };
        });

      // Add group-only permissions (groups themselves, not individual users through groups)
      const groupPermissions = permissions
        .filter((p) => p.groupId && !p.userId)
        .map((p) => ({
          spaceId: p.resourceId,
          userId: undefined,
          groupId: p.groupId,
          role: p.permission,
          joinedAt: p.createdAt,
          user: undefined,
        }));

      members.push(...groupPermissions);

      // Add group members as individual entries
      for (const [userId, userGroupIds] of groupMembers) {
        const userData = userMap.get(userId);
        if (userData) {
          for (const groupId of userGroupIds) {
            const groupPermission = permissions.find((p) => p.groupId === groupId);
            if (groupPermission) {
              members.push({
                spaceId: groupPermission.resourceId,
                userId,
                groupId,
                role: groupPermission.permission,
                joinedAt: groupPermission.createdAt,
                user: {
                  id: userData.id,
                  name: userData.name,
                  email: canSeeEmails ? userData.email : undefined,
                  image: resolveProfileImage(userData),
                },
              });
              break;
            }
          }
        }
      }

      // Add resource-scoped-only grantees (no space-wide role, not covered
      // by any of the entries above) purely so their name/avatar resolves.
      const alreadyListedUserIds = new Set(
        members.map((m) => m.userId).filter((id): id is string => !!id),
      );
      for (const userId of resourceScopedUserIds) {
        if (alreadyListedUserIds.has(userId)) continue;
        const userData = userMap.get(userId);
        if (!userData) continue;
        members.push({
          spaceId,
          userId,
          groupId: undefined,
          role: "",
          joinedAt: userData.createdAt,
          user: {
            id: userData.id,
            name: userData.name,
            email: canSeeEmails ? userData.email : undefined,
            image: resolveProfileImage(userData),
          },
        });
      }

      return jsonResponse(members);
    },
    { fallbackMessage: "Failed to list space members" },
  );
