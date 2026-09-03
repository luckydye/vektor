const idPrefixes = {
  accessToken: "token",
  category: "category",
  comment: "comment",
  document: "doc",
  emailNotification: "email_notification",
  externalLink: "extlink",
  oauthIntegration: "oauth",
  oauthIntegrationState: "oauth_state",
  preference: "pref",
  property: "prop",
  revision: "rev",
  run: "run",
  secret: "secret",
  shareLink: "share",
  space: "space",
  workflowSchedule: "sched",
} as const;

export type IdType = keyof typeof idPrefixes;

export function createId(type: IdType): string {
  return `${idPrefixes[type]}_${crypto.randomUUID()}`;
}

/**
 * Whether a caller-supplied document id is usable.
 *
 * An id reaches a URL path, so the character set is the unreserved one from
 * RFC 3986 and nothing else. A caller derives ids from identifiers of its own —
 * typically a hash — so this is a shape check, not a uniqueness one: the
 * primary key decides that.
 */
export function isValidDocumentId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && /^[A-Za-z0-9._~-]+$/.test(id);
}
