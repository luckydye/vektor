import { inArray } from "drizzle-orm";
import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  getResourceScopedGranteeUserIds,
  getSpaceMembersWithGroups,
  getUserGroups,
  hasPermission,
  listPermissions,
  ResourceType,
} from "#db/acl.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { getAuthDb } from "#db/db.ts";
import { user as userTable } from "#db/schema/auth.ts";
import { getSpace } from "#db/spaces.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.var.params, "spaceId");

      await verifySpaceRole(spaceId, user.id, "viewer");

      // Member email addresses are PII: only expose them to editors/owners
      // (who need them e.g. for mentions); plain viewers get id/name/image.
      const space = await getSpace(spaceId);
      const canSeeEmails =
        space?.createdBy === user.id ||
        (await hasPermission(
          spaceId,
          ResourceType.SPACE,
          spaceId,
          user.id,
          "editor",
          await getUserGroups(user.id),
        ));

      const permissions = await listPermissions(spaceId, ResourceType.SPACE, spaceId);
      const { directUserIds, groupMembers } = await getSpaceMembersWithGroups(spaceId);

      // Users who only hold a document/tree/category grant (no space-wide
      // role) still need to resolve to a name/avatar wherever this endpoint
      // is used to look up "who is userId X" — comments, revisions,
      // mentions, the members table itself.
      const resourceScopedUserIds = await getResourceScopedGranteeUserIds(spaceId);

      // Fetch user data for all members
      const authDb = getAuthDb();
      const allUserIds = [
        ...new Set([...directUserIds, ...groupMembers.keys(), ...resourceScopedUserIds]),
      ];
      const users = await authDb
        .select()
        .from(userTable)
        .where(inArray(userTable.id, allUserIds))
        .all();

      const userMap = new Map(users.map((u) => [u.id, u]));

      // Add direct user permissions
      const members = permissions
        .filter((p) => p.userId && !p.groupId)
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
                  image: userData.image,
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
                  image: userData.image,
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
            image: userData.image,
          },
        });
      }

      return jsonResponse(members);
    },
    { fallbackMessage: "Failed to list space members" },
  );
