/**
 * Who gets emailed about a change, and why.
 *
 * The recipient set is policy, not storage: contributors and mentions and
 * thread participants, minus the actor, minus anyone who muted the document.
 * The queries behind each of those live in the repository that owns the table;
 * writing the resulting rows is `insertEmailNotifications`.
 */

import { config } from "#config";
import { getUserIdsByEmail } from "#db/auth/users.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { listDocumentContributorIds } from "#db/space/auditLogs.ts";
import { listThreadParticipantIds } from "#db/space/comments.ts";
import { getEmailMutedUserIds } from "#db/space/emailNotificationPreferences.ts";
import {
  type EmailNotificationInit,
  insertEmailNotifications,
} from "#db/space/emailOutbox.ts";
import { getPublishedContent } from "#db/space/revisions.ts";
import { getUniqueMentionedEmails } from "#documents/mentions.ts";

async function mentionedUserIds(html: string | null): Promise<string[]> {
  if (!html) return [];
  return getUserIdsByEmail(getUniqueMentionedEmails(html));
}

/**
 * Drop the actor and anyone who muted the document, then queue the rest.
 * Without SMTP configured nothing is queued at all, so a deployment that never
 * sends mail does not accumulate an unbounded outbox — except in dev and test,
 * where the rows are the point.
 */
async function enqueueRecipients(
  spaceId: string,
  notification: EmailNotificationInit,
  recipientUserIds: Iterable<string>,
): Promise<number> {
  const appConfig = config();
  const deliveryConfigured =
    !!appConfig.EMAIL_FROM?.trim() && !!appConfig.SMTP_HOST?.trim();
  const developmentDelivery = import.meta.env.DEV || appConfig.NODE_ENV === "test";
  if (!deliveryConfigured && !developmentDelivery) return 0;

  const candidates = [...new Set(recipientUserIds)].filter(
    (userId) => userId !== notification.actorId,
  );
  const store = await openSpaceStore(spaceId);
  const muted = await getEmailMutedUserIds(store, candidates, notification.documentId);

  return insertEmailNotifications(
    store,
    notification,
    candidates.filter((userId) => !muted.has(userId)),
  );
}

export async function enqueueDocumentPublishedEmails(params: {
  spaceId: string;
  documentId: string;
  publicationId: number;
  revision: number;
  previousPublishedRevision: number | null;
  publishedHtml: string;
  actorId: string;
}): Promise<number> {
  const [contributors, mentioned] = await Promise.all([
    listDocumentContributorIds(await openSpaceStore(params.spaceId), params.documentId),
    mentionedUserIds(params.publishedHtml),
  ]);

  return enqueueRecipients(
    params.spaceId,
    {
      kind: "document_published",
      sourceId: String(params.publicationId),
      documentId: params.documentId,
      publishedRevision: params.revision,
      previousPublishedRevision: params.previousPublishedRevision,
      actorId: params.actorId,
    },
    [...contributors, ...mentioned],
  );
}

export async function enqueueCommentCreatedEmails(params: {
  spaceId: string;
  documentId: string;
  commentId: string;
  commentReference: string | null;
  commentParentId: string | null;
  actorId: string;
}): Promise<number> {
  const [contributors, publishedHtml, threadParticipants] = await Promise.all([
    listDocumentContributorIds(await openSpaceStore(params.spaceId), params.documentId),
    getPublishedContent(await openSpaceStore(params.spaceId), params.documentId),
    listThreadParticipantIds(
      await openSpaceStore(params.spaceId),
      params.documentId,
      params.commentReference,
      params.commentParentId,
    ),
  ]);
  const mentioned = await mentionedUserIds(publishedHtml);

  return enqueueRecipients(
    params.spaceId,
    {
      kind: "comment_created",
      sourceId: params.commentId,
      documentId: params.documentId,
      actorId: params.actorId,
    },
    [...contributors, ...mentioned, ...threadParticipants],
  );
}
