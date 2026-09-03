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
  // `isValidDocumentId` below is this shape written as a pattern. Change one and
  // the other stops recognising ids it minted.
  return `${idPrefixes[type]}_${crypto.randomUUID()}`;
}

/**
 * Whether a caller-supplied document id is one this system would have minted.
 *
 * Exactly the shape {@link createId} produces, so every id in the database
 * looks like every other and none of them is a caller's choice of string. A
 * caller that needs to compute an id rather than read one back derives a
 * UUIDv5 from its own identifier — which is what that version is for — and the
 * result is indistinguishable from a generated one.
 *
 * Shape only. Uniqueness is the primary key's to decide.
 */
export function isValidDocumentId(id: string): boolean {
  return /^doc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}
