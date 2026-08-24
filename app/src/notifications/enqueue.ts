/**
 * Who gets emailed about a change, and why.
 *
 * The recipient set is policy, not storage: contributors and mentions and
 * thread participants, minus the actor, minus anyone who muted the document.
 * A mentioned user is notified about the mention instead of the change that
 * carried it, so each event splits into a `*_mention` fan-out and a generic one
 * over everybody else. The queries behind each of those live in the repository
 * that owns the table; writing the resulting rows is `insertEmailNotifications`.
 *
 * A space invitation has no such fan-out — one grant, one recipient — so it
 * only shares the muting rules and the "is mail configured at all" guard.
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
import { getRevisionContent } from "#db/space/revisions.ts";
import { getUniqueMentionedEmails } from "#documents/mentions.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";

async function mentionedUserIds(html: string | null): Promise<string[]> {
  if (!html) return [];
  return getUserIdsByEmail(getUniqueMentionedEmails(html));
}

/**
 * Without SMTP configured nothing is queued at all, so a deployment that never
 * sends mail does not accumulate an unbounded outbox — except in dev and test,
 * where the rows are the point.
 */
function queueingIsWorthwhile(): boolean {
  const appConfig = config();
  const deliveryConfigured =
    !!appConfig.EMAIL_FROM?.trim() && !!appConfig.SMTP_HOST?.trim();
  return deliveryConfigured || import.meta.env.DEV || appConfig.NODE_ENV === "test";
}

/** Drop the actor and anyone who muted the document, then queue the rest. */
async function enqueueRecipients(
  spaceId: string,
  notification: EmailNotificationInit,
  recipientUserIds: Iterable<string>,
): Promise<number> {
  if (!queueingIsWorthwhile()) return 0;

  const candidates = [...new Set(recipientUserIds)].filter(
    (userId) => userId !== notification.actorId,
  );
  const store = await openSpaceStore(spaceId);
  const muted = await getEmailMutedUserIds(
    store,
    candidates,
    notification.documentId ?? undefined,
  );

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
  const store = await openSpaceStore(params.spaceId);
  const [contributors, mentioned, previousHtml] = await Promise.all([
    listDocumentContributorIds(store, params.documentId),
    mentionedUserIds(params.publishedHtml),
    params.previousPublishedRevision === null
      ? null
      : getRevisionContent(store, params.documentId, params.previousPublishedRevision),
  ]);

  // A mention is news the first time it reaches a published revision. Everyone
  // mentioned earlier stays on the generic fan-out, or every later publish
  // would announce the same mention again.
  const carriedOver = new Set(await mentionedUserIds(previousHtml));
  const newlyMentioned = mentioned.filter((userId) => !carriedOver.has(userId));
  const announced = new Set(newlyMentioned);

  const source = {
    sourceId: String(params.publicationId),
    documentId: params.documentId,
    publishedRevision: params.revision,
    previousPublishedRevision: params.previousPublishedRevision,
    actorId: params.actorId,
  };

  const queued = await Promise.all([
    enqueueRecipients(
      params.spaceId,
      { ...source, kind: "document_mention" },
      newlyMentioned,
    ),
    enqueueRecipients(
      params.spaceId,
      { ...source, kind: "document_published" },
      [...contributors, ...mentioned].filter((userId) => !announced.has(userId)),
    ),
  ]);

  return queued[0] + queued[1];
}

export async function enqueueCommentCreatedEmails(params: {
  spaceId: string;
  documentId: string;
  commentId: string;
  /** Null for a comment that is not text at all, such as a reaction. */
  commentContent: string | null;
  commentReference: string | null;
  commentParentId: string | null;
  actorId: string;
}): Promise<number> {
  const store = await openSpaceStore(params.spaceId);
  const [contributors, threadParticipants, mentioned] = await Promise.all([
    listDocumentContributorIds(store, params.documentId),
    listThreadParticipantIds(
      store,
      params.documentId,
      params.commentReference,
      params.commentParentId,
    ),
    // A comment is stored as markdown; a mention is only a `<user-mention>`
    // once rendered, which is also how the thread displays it.
    mentionedUserIds(
      params.commentContent ? renderMessageMarkdown(params.commentContent) : null,
    ),
  ]);

  const announced = new Set(mentioned);
  const source = {
    sourceId: params.commentId,
    documentId: params.documentId,
    actorId: params.actorId,
  };

  const queued = await Promise.all([
    enqueueRecipients(params.spaceId, { ...source, kind: "comment_mention" }, mentioned),
    enqueueRecipients(
      params.spaceId,
      { ...source, kind: "comment_created" },
      [...contributors, ...threadParticipants].filter((userId) => !announced.has(userId)),
    ),
  ]);

  return queued[0] + queued[1];
}

/**
 * Queue the mail announcing that somebody was let into the space.
 *
 * The grant's own timestamp is the source, so one grant queues one mail while a
 * member removed and let back in — a row deleted and reinserted — is news
 * again. Muting the space silences it like anything else: the row carries no
 * document, which is the case the mute preference falls back to space-wide on.
 */
export async function enqueueSpaceInvitationEmail(params: {
  spaceId: string;
  grantedAt: Date;
  recipientUserId: string;
  actorId: string;
  role: string;
}): Promise<number> {
  return enqueueRecipients(
    params.spaceId,
    {
      kind: "space_invitation",
      sourceId: String(params.grantedAt.getTime()),
      actorId: params.actorId,
      role: params.role,
    },
    [params.recipientUserId],
  );
}
