import { createMemo } from "solid-js";
import { type AuditLog, api } from "#api/client.ts";
import { t } from "#utils/lang.ts";
import { userDisplayName } from "#utils/userDisplay.ts";
import { spacePath } from "#utils/utils.ts";
import { access, type MaybeAccessor, useQuery } from "./query.solid.ts";
import { useSpace } from "./useSpace.solid.ts";

interface ActivityUser {
  id: string;
  name: string;
  email?: string;
  image?: string | null;
}

/** Only the slug is read — it is both the label and the href segment. */
interface ActivityDocument {
  slug: string;
}

/**
 * A space's recent audit log, resolved for display.
 *
 * Audit entries reference users and documents by id only, so this fetches the
 * space's members alongside the log and looks up each referenced document,
 * then hands back resolvers rather than raw maps. Document lookups are
 * best-effort: one that fails (deleted, or not visible to this user) leaves
 * that entry rendering a placeholder instead of failing the whole feed.
 */
export function useSpaceActivity(
  spaceId: MaybeAccessor<string>,
  limit: MaybeAccessor<number> = 10,
) {
  const { currentSpace } = useSpace();

  const {
    data,
    isPending: isLoading,
    error: queryError,
  } = useQuery({
    queryKey: createMemo(() => ["space_activity", access(spaceId), access(limit)]),
    queryFn: async () => {
      const id = access(spaceId);
      const [logsData, membersData] = await Promise.all([
        api.auditLogs.get(id, { limit: access(limit) }),
        api.spaceMembers.get(id),
      ]);

      const activities = logsData.auditLogs;

      const usersMap = new Map<string, ActivityUser>();
      for (const member of membersData) {
        if (member.user) usersMap.set(member.user.id, member.user);
      }

      const docIds = new Set<string>();
      for (const activity of activities) {
        if (activity.docId && activity.docId !== id) docIds.add(activity.docId);
      }

      const docsMap = new Map<string, ActivityDocument>();
      await Promise.all(
        Array.from(docIds).map(async (docId) => {
          try {
            docsMap.set(docId, await api.document.get(id, docId));
          } catch {
            // best-effort
          }
        }),
      );

      return { activities, usersMap, docsMap };
    },
  });

  function getUser(userId?: string | null): ActivityUser | undefined {
    if (!userId) return undefined;
    return data()?.usersMap.get(userId);
  }

  /** Entries against the space itself are shown as its home page. */
  function getDocumentName(docId: string): string {
    if (docId === access(spaceId)) return t("Home");
    return data()?.docsMap.get(docId)?.slug ?? t("Unknown document");
  }

  function getDocumentHref(docId: string): string | undefined {
    if (docId === access(spaceId)) return spacePath(currentSpace()?.slug, "/");
    const doc = data()?.docsMap.get(docId);
    if (!doc?.slug) return undefined;
    return spacePath(currentSpace()?.slug, `/doc/${doc.slug}`);
  }

  return {
    activities: createMemo<AuditLog[]>(() => data()?.activities ?? []),
    isLoading,
    error: createMemo(() => queryError()?.message ?? null),
    getUser,
    getUserName: (userId?: string | null) => userDisplayName(getUser(userId), userId),
    getDocumentName,
    getDocumentHref,
  };
}
