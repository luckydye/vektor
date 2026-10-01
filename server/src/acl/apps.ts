/**
 * Apps the server runs itself, each named after the extension that enables it.
 * An app acts as its own ACL principal, granted access like a user.
 */
export const SERVER_APPS = [{ id: "discord", label: "Discord bot" }] as const;

export type ServerApp = (typeof SERVER_APPS)[number];

/** Apps that act with the access of the user who started them, by id. */
const DELEGATE_APP_LABELS: Record<string, string> = {
  agent: "Agent",
  mcp: "MCP client",
  workflow: "Workflow",
};

/**
 * Which app performed an action, and for whom when that is not the principal
 * whose access it used. Recorded on audit entries, carried in job tokens.
 */
export interface Attribution {
  /** An app above, or the id of the extension whose job acted. */
  app: string;
  /** A Vektor user when known, else the name the person goes by in the app. */
  onBehalfOf?: { userId?: string; name: string };
}

export function appPrincipal(appId: string): string {
  return `app:${appId}`;
}

/** The app a principal id names, or null for a user, group or token. */
export function appOfPrincipal(principal: string): ServerApp | null {
  return SERVER_APPS.find((app) => appPrincipal(app.id) === principal) ?? null;
}

/** A display name for an attribution's app; an extension shows as its id. */
export function appLabel(appId: string): string {
  return (
    SERVER_APPS.find((app) => app.id === appId)?.label ??
    DELEGATE_APP_LABELS[appId] ??
    appId
  );
}
