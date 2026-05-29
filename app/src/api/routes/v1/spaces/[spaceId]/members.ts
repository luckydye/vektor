import type { APIRoute } from "astro";
import { inArray } from "drizzle-orm";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  listPermissions,
  ResourceType,
  getSpaceMembersWithGroups,
} from "#db/acl.ts";
import { getAuthDb } from "#db/db.ts";
import { user as userTable } from "#db/schema/auth.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.params, "spaceId");

      await verifySpaceRole(spaceId, user.id, "viewer");

      const permissions = await listPermissions(spaceId, ResourceType.SPACE, spaceId);
      const { directUserIds, groupMembers } = await getSpaceMembersWithGroups(spaceId);

      // Fetch user data for all members
      const authDb = getAuthDb();
      const allUserIds = [...directUserIds, ...groupMembers.keys()];
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
                  email: userData.email,
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
                  email: userData.email,
                  image: userData.image,
                },
              });
              break;
            }
          }
        }
      }

      return jsonResponse(members);
    },
    { fallbackMessage: "Failed to list space members" },
  );
