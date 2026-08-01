import { createMemo } from "solid-js";
import { type AuditLog, api } from "#api/client.ts";
import { documentTitle } from "#documents/title.ts";
import { t } from "#utils/lang.ts";
import { userDisplayName } from "#utils/userDisplay.ts";
import { spacePath } from "#utils/utils.ts";
import { access, type MaybeAccessor, useQuery } from "./query.ts";
import { useDocuments } from "./useDocuments.ts";
import { useSpace } from "./useSpace.ts";

interface ActivityUser {
  id: string;
  name: string;
  email?: string;
  image?: string | null;
}

/**
 * A space's recent audit log, resolved for display.
 *
 * Audit entries reference users and documents by id only, so this fetches the
 * space's members alongside the log and hands back resolvers rather than raw
 * maps. Documents are *not* fetched: a link needs only the id, and the title
 * comes from the space's document listing, which the shell has already loaded.
 * An id missing from that listing — deleted, or not visible to this user —
 * renders a placeholder instead of failing the feed.
 */
export function useSpaceActivity(
  spaceId: MaybeAccessor<string>,
  limit: MaybeAccessor<number> = 10,
) {
  const { currentSpace } = useSpace();
  const { documents } = useDocuments();

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

      return { activities, usersMap };
    },
  });

  const documentsById = createMemo(
    () => new Map(documents().map((document) => [document.id, document])),
  );

  function getUser(userId?: string | null): ActivityUser | undefined {
    if (!userId) return undefined;
    return data()?.usersMap.get(userId);
  }

  /** Entries against the space itself are shown as its home page. */
  function getDocumentName(docId: string): string {
    if (docId === access(spaceId)) return t("Home");
    const document = documentsById().get(docId);
    return document ? documentTitle(document) : t("Unknown document");
  }

  function getDocumentHref(docId: string): string {
    if (docId === access(spaceId)) return spacePath(currentSpace()?.slug, "/");
    // The id addresses the document as well as its slug does: the API resolves
    // either, and the page redirects an id to the canonical slug URL. Linking
    // by id keeps the feed from having to know a document to link to it.
    return spacePath(currentSpace()?.slug, `/doc/${docId}`);
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
