const idPrefixes = {
  accessToken: "token",
  category: "category",
  comment: "comment",
  document: "doc",
  oauthIntegration: "oauth",
  oauthIntegrationState: "oauth_state",
  preference: "pref",
  property: "prop",
  revision: "rev",
  run: "run",
  secret: "secret",
  space: "space",
  webhook: "webhook",
} as const;

export type IdType = keyof typeof idPrefixes;

export function createId(type: IdType): string {
  return `${idPrefixes[type]}_${crypto.randomUUID()}`;
}
