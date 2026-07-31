import { t } from "#utils/lang.ts";

/**
 * Rendering a user's identity: resolving an id to a record, and turning that
 * record into a label. Every "who did this" string in the app goes through
 * here, so the fallback chain is the same everywhere.
 *
 * Framework-free by design — it outlives the Vue components that currently
 * call it. The one import, `t`, is the same seam `datetime.ts` already uses.
 */

/**
 * The subset of a user that display code needs. Satisfied by the API's user
 * records, a space member's `user`, and a comment's embedded `createdByUser`,
 * all of which disagree about which fields are nullable.
 */
export interface DisplayUser {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

/** A space membership row, as `useMembers()` returns them. */
interface Membership {
  /** Optional: a group membership has a groupId instead. */
  userId?: string;
  user?: DisplayUser | null;
}

/**
 * Resolve a user id against a member list. Returns `undefined` rather than
 * throwing on a missing or unknown id — callers render this straight into a
 * template.
 */
export function findMemberUser(
  members: readonly Membership[] | null | undefined,
  userId: string | null | undefined,
): DisplayUser | undefined {
  if (!userId) return undefined;
  return members?.find((member) => member.userId === userId)?.user ?? undefined;
}

/**
 * Best available label for a user: real name, then email, then the raw id, then
 * a localized placeholder.
 *
 * Pass `userId` even when `user` resolved — it is the fallback that keeps an
 * unknown actor traceable instead of collapsing every one of them into
 * "Unknown user".
 */
export function userDisplayName(
  user: DisplayUser | null | undefined,
  userId?: string | null,
): string {
  return user?.name || user?.email || userId || t("Unknown user");
}
