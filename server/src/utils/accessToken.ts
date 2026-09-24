/**
 * How an ACL row reads in a listing — the tokens that carry a credential, and
 * the role any grant was made at. Shared by space settings and the personal
 * token panel so the two look like the same system.
 */

import { t } from "#utils/lang.ts";

export type AccessTokenStatus = "Active" | "Expired" | "Revoked";

/** Whether a token can still be used, and why not when it cannot. */
export function tokenStatus(token: {
  revokedAt: Date | string | null;
  expiresAt: Date | string | null;
}): AccessTokenStatus {
  if (token.revokedAt) return "Revoked";
  if (token.expiresAt && new Date(token.expiresAt) < new Date()) return "Expired";
  return "Active";
}

export function tokenStatusClass(status: AccessTokenStatus): string {
  if (status === "Revoked") return "bg-red-500/10 text-red-600";
  if (status === "Expired") return "bg-yellow-500/10 text-yellow-700";
  return "bg-green-500/10 text-green-700";
}

/** The level a token was granted — its ceiling, not necessarily what it can do. */
export function tokenRole(token: {
  resources?: Array<{ resourceType: string; permission: string }>;
}): string {
  const grant = token.resources?.[0];
  if (!grant) return "none";
  return grant.resourceType === "feature" ? "capability" : grant.permission;
}

/** Phrased as what the person may do, not as a role name. */
export function roleLabel(role: string, lang: string): string {
  if (role === "owner") return t("Owner", lang);
  if (role === "editor") return t("Can edit", lang);
  if (role === "viewer") return t("Can view", lang);
  return role;
}

/** Alpha tones rather than flat palettes, so the pill follows the theme. */
export function roleBadgeClass(role: string): string {
  if (role === "owner") return "bg-purple-500/15 text-purple-700";
  if (role === "editor") return "bg-green-500/15 text-green-700";
  return "bg-neutral-500/15 text-neutral-700";
}
