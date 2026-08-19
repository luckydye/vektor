import { GROUP_NAME_PATTERN } from "#acl/permissions.ts";

export const NO_GROUPS = "[]";

/**
 * Group membership drives ACL access, so a compromised or loosely-configured IdP
 * must not be able to inject arbitrary or privileged group names.
 *
 * An absent claim returns `undefined`, leaving the stored groups as they are:
 * sign-in and the periodic re-read both rewrite the column, so a response that
 * merely omits the claim must not strip a user's grants. An empty array is
 * honoured — that is the IdP saying "no groups", and it has to revoke.
 */
export function sanitizeOAuthGroups(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return NO_GROUPS;
  const groups = raw
    .filter((g): g is string => typeof g === "string" && GROUP_NAME_PATTERN.test(g))
    .slice(0, 100);
  return JSON.stringify([...new Set(groups)]);
}
