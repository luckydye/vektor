const idPrefixes = {
  accessToken: "token",
  category: "category",
  comment: "comment",
  document: "doc",
  emailNotification: "email_notification",
  oauthIntegration: "oauth",
  oauthIntegrationState: "oauth_state",
  preference: "pref",
  property: "prop",
  revision: "rev",
  run: "run",
  secret: "secret",
  shareLink: "share",
  space: "space",
  sshKey: "sshkey",
  workflowSchedule: "sched",
} as const;

export type IdType = keyof typeof idPrefixes;

export function createId(type: IdType): string {
  return `${idPrefixes[type]}_${crypto.randomUUID()}`;
}
