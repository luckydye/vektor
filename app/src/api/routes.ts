// CalDAV discovery (served outside the /api namespace)
import * as wellKnownCaldav from "./extra/wellKnownCaldav.ts";

// Auth (better-auth catch-all)
import * as authAll from "./routes/auth/[...all].ts";

// CalDAV
import * as caldavEvent from "./routes/caldav/calendars/[userId]/[spaceId]/[eventId].ts";
import * as caldavCalendar from "./routes/caldav/calendars/[userId]/[spaceId]/index.ts";
import * as caldavCalendars from "./routes/caldav/calendars/[userId]/index.ts";
import * as caldavPrincipal from "./routes/caldav/principals/[userId].ts";

// Chat
import * as chatAcp from "./routes/v1/chat/acp.ts";
import * as chatCompletions from "./routes/v1/chat/completions.ts";
import * as accessTokenResource from "./routes/v1/spaces/[spaceId]/access-tokens/[tokenId]/resources/[resourceType]/[resourceId].ts";
// Access tokens
import * as accessToken from "./routes/v1/spaces/[spaceId]/access-tokens/[tokenId].ts";
import * as accessTokens from "./routes/v1/spaces/[spaceId]/access-tokens/index.ts";

// AI chat sessions
import * as aiChatSession from "./routes/v1/spaces/[spaceId]/ai-chat/sessions/[sessionId].ts";
import * as aiChatSessions from "./routes/v1/spaces/[spaceId]/ai-chat/sessions/index.ts";

// Space-level resources
import * as spaceAuditLogs from "./routes/v1/spaces/[spaceId]/audit-logs.ts";
import * as category from "./routes/v1/spaces/[spaceId]/categories/[id].ts";
import * as categories from "./routes/v1/spaces/[spaceId]/categories/index.ts";

// Documents
import * as documentAuditLogs from "./routes/v1/spaces/[spaceId]/documents/[documentId]/audit-logs.ts";
import * as documentChildren from "./routes/v1/spaces/[spaceId]/documents/[documentId]/children.ts";
import * as documentComments from "./routes/v1/spaces/[spaceId]/documents/[documentId]/comments.ts";
import * as documentContributors from "./routes/v1/spaces/[spaceId]/documents/[documentId]/contributors.ts";
import * as documentDiff from "./routes/v1/spaces/[spaceId]/documents/[documentId]/diff.ts";
import * as documentEdit from "./routes/v1/spaces/[spaceId]/documents/[documentId]/edit.ts";
import * as document from "./routes/v1/spaces/[spaceId]/documents/[documentId]/index.ts";
import * as documentRevisions from "./routes/v1/spaces/[spaceId]/documents/[documentId]/revisions.ts";
import * as documentsArchived from "./routes/v1/spaces/[spaceId]/documents/archived.ts";
import * as documents from "./routes/v1/spaces/[spaceId]/documents/index.ts";

// Extensions
import * as extensionAsset from "./routes/v1/spaces/[spaceId]/extensions/[extensionId]/assets/[...path].ts";
import * as extension from "./routes/v1/spaces/[spaceId]/extensions/[extensionId]/index.ts";
import * as extensions from "./routes/v1/spaces/[spaceId]/extensions/index.ts";

import * as spaceImport from "./routes/v1/spaces/[spaceId]/import.ts";
import * as space from "./routes/v1/spaces/[spaceId]/index.ts";

// Integrations
import * as integrationCallback from "./routes/v1/spaces/[spaceId]/integrations/[provider]/callback.ts";
import * as integrationConnect from "./routes/v1/spaces/[spaceId]/integrations/[provider]/connect.ts";
import * as integration from "./routes/v1/spaces/[spaceId]/integrations/[provider]/index.ts";
import * as integrationProxy from "./routes/v1/spaces/[spaceId]/integrations/[provider]/proxy.ts";
import * as integrations from "./routes/v1/spaces/[spaceId]/integrations/index.ts";

import * as jobsRun from "./routes/v1/spaces/[spaceId]/jobs/run.ts";
import * as jobRuns from "./routes/v1/spaces/[spaceId]/jobs/runs.ts";
import * as jobSchedule from "./routes/v1/spaces/[spaceId]/jobs/schedules/[scheduleId].ts";
import * as jobSchedules from "./routes/v1/spaces/[spaceId]/jobs/schedules/index.ts";
import * as mcp from "./routes/v1/spaces/[spaceId]/mcp.ts";
import * as members from "./routes/v1/spaces/[spaceId]/members.ts";

// Permissions
import * as permissions from "./routes/v1/spaces/[spaceId]/permissions/index.ts";
import * as permissionsMe from "./routes/v1/spaces/[spaceId]/permissions/me.ts";

import * as properties from "./routes/v1/spaces/[spaceId]/properties.ts";

// Search
import * as search from "./routes/v1/spaces/[spaceId]/search/index.ts";
import * as searchRebuild from "./routes/v1/spaces/[spaceId]/search/rebuild.ts";

// Secrets
import * as secret from "./routes/v1/spaces/[spaceId]/secrets/[name].ts";
import * as secrets from "./routes/v1/spaces/[spaceId]/secrets/index.ts";

// Uploads
import * as uploadFile from "./routes/v1/spaces/[spaceId]/uploads/[...path].ts";
import * as uploads from "./routes/v1/spaces/[spaceId]/uploads/index.ts";
import * as webhook from "./routes/v1/spaces/[spaceId]/webhooks/[webhookId].ts";
// Webhooks
import * as webhooks from "./routes/v1/spaces/[spaceId]/webhooks.ts";

// Workflow runs
import * as workflowRun from "./routes/v1/spaces/[spaceId]/workflows/runs/[runId].ts";
import * as workflowRuns from "./routes/v1/spaces/[spaceId]/workflows/runs/index.ts";

import * as spaces from "./routes/v1/spaces/index.ts";
import * as urlMetadata from "./routes/v1/url-metadata.ts";
import * as users from "./routes/v1/users/index.ts";
import * as usersMe from "./routes/v1/users/me.ts";
import type { ApiRouteModule } from "./server/types.ts";

export interface ApiRoute {
  /** Astro-style path pattern, e.g. `/api/v1/spaces/[spaceId]`. */
  pattern: string;
  module: ApiRouteModule;
}

/**
 * The complete set of HTTP routes served by the Express API.
 *
 * Patterns use Astro's bracket syntax: `[param]` for a single segment and
 * `[...rest]` for a catch-all. Order does not matter — the router sorts by
 * specificity, so static segments win over params, which win over catch-alls.
 */
export const apiRoutes: ApiRoute[] = [
  { pattern: "/api/auth/[...all]", module: authAll },

  { pattern: "/api/caldav/calendars/[userId]/[spaceId]/[eventId]", module: caldavEvent },
  { pattern: "/api/caldav/calendars/[userId]/[spaceId]", module: caldavCalendar },
  { pattern: "/api/caldav/calendars/[userId]", module: caldavCalendars },
  { pattern: "/api/caldav/principals/[userId]", module: caldavPrincipal },

  { pattern: "/api/v1/chat/acp", module: chatAcp },
  { pattern: "/api/v1/chat/completions", module: chatCompletions },

  { pattern: "/api/v1/spaces", module: spaces },
  { pattern: "/api/v1/spaces/[spaceId]", module: space },
  { pattern: "/api/v1/spaces/[spaceId]/import", module: spaceImport },
  { pattern: "/api/v1/spaces/[spaceId]/audit-logs", module: spaceAuditLogs },
  { pattern: "/api/v1/spaces/[spaceId]/members", module: members },
  { pattern: "/api/v1/spaces/[spaceId]/properties", module: properties },
  { pattern: "/api/v1/spaces/[spaceId]/mcp", module: mcp },
  { pattern: "/api/v1/spaces/[spaceId]/jobs/run", module: jobsRun },
  { pattern: "/api/v1/spaces/[spaceId]/jobs/runs", module: jobRuns },
  { pattern: "/api/v1/spaces/[spaceId]/jobs/schedules", module: jobSchedules },
  {
    pattern: "/api/v1/spaces/[spaceId]/jobs/schedules/[scheduleId]",
    module: jobSchedule,
  },

  { pattern: "/api/v1/spaces/[spaceId]/access-tokens", module: accessTokens },
  { pattern: "/api/v1/spaces/[spaceId]/access-tokens/[tokenId]", module: accessToken },
  {
    pattern:
      "/api/v1/spaces/[spaceId]/access-tokens/[tokenId]/resources/[resourceType]/[resourceId]",
    module: accessTokenResource,
  },

  { pattern: "/api/v1/spaces/[spaceId]/ai-chat/sessions", module: aiChatSessions },
  {
    pattern: "/api/v1/spaces/[spaceId]/ai-chat/sessions/[sessionId]",
    module: aiChatSession,
  },

  { pattern: "/api/v1/spaces/[spaceId]/categories", module: categories },
  { pattern: "/api/v1/spaces/[spaceId]/categories/[id]", module: category },

  { pattern: "/api/v1/spaces/[spaceId]/documents", module: documents },
  { pattern: "/api/v1/spaces/[spaceId]/documents/archived", module: documentsArchived },
  { pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]", module: document },
  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/audit-logs",
    module: documentAuditLogs,
  },
  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/children",
    module: documentChildren,
  },
  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/comments",
    module: documentComments,
  },
  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/contributors",
    module: documentContributors,
  },
  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/diff",
    module: documentDiff,
  },
  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/edit",
    module: documentEdit,
  },
  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/revisions",
    module: documentRevisions,
  },

  { pattern: "/api/v1/spaces/[spaceId]/extensions", module: extensions },
  { pattern: "/api/v1/spaces/[spaceId]/extensions/[extensionId]", module: extension },
  {
    pattern: "/api/v1/spaces/[spaceId]/extensions/[extensionId]/assets/[...path]",
    module: extensionAsset,
  },

  { pattern: "/api/v1/spaces/[spaceId]/integrations", module: integrations },
  { pattern: "/api/v1/spaces/[spaceId]/integrations/[provider]", module: integration },
  {
    pattern: "/api/v1/spaces/[spaceId]/integrations/[provider]/connect",
    module: integrationConnect,
  },
  {
    pattern: "/api/v1/spaces/[spaceId]/integrations/[provider]/callback",
    module: integrationCallback,
  },
  {
    pattern: "/api/v1/spaces/[spaceId]/integrations/[provider]/proxy",
    module: integrationProxy,
  },

  { pattern: "/api/v1/spaces/[spaceId]/permissions", module: permissions },
  { pattern: "/api/v1/spaces/[spaceId]/permissions/me", module: permissionsMe },

  { pattern: "/api/v1/spaces/[spaceId]/search", module: search },
  { pattern: "/api/v1/spaces/[spaceId]/search/rebuild", module: searchRebuild },

  { pattern: "/api/v1/spaces/[spaceId]/secrets", module: secrets },
  { pattern: "/api/v1/spaces/[spaceId]/secrets/[name]", module: secret },

  { pattern: "/api/v1/spaces/[spaceId]/uploads", module: uploads },
  { pattern: "/api/v1/spaces/[spaceId]/uploads/[...path]", module: uploadFile },

  { pattern: "/api/v1/spaces/[spaceId]/webhooks", module: webhooks },
  { pattern: "/api/v1/spaces/[spaceId]/webhooks/[webhookId]", module: webhook },

  { pattern: "/api/v1/spaces/[spaceId]/workflows/runs", module: workflowRuns },
  { pattern: "/api/v1/spaces/[spaceId]/workflows/runs/[runId]", module: workflowRun },

  { pattern: "/api/v1/url-metadata", module: urlMetadata },
  { pattern: "/api/v1/users", module: users },
  { pattern: "/api/v1/users/me", module: usersMe },

  { pattern: "/.well-known/caldav", module: wellKnownCaldav },
];
