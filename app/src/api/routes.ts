import * as authAll from "./routes/auth/all.ts";
import * as authCli from "./routes/auth/cli.ts";
import * as authCliToken from "./routes/auth/cli-token.ts";
import * as caldavCalendar from "./routes/caldav/calendar.ts";
import * as caldavCalendars from "./routes/caldav/calendars.ts";
import * as caldavEvent from "./routes/caldav/event.ts";
import * as caldavPrincipal from "./routes/caldav/principal.ts";
import * as chatAcp from "./routes/chat/acp.ts";
import * as chatCompletions from "./routes/chat/completions.ts";
import * as proxyMedia from "./routes/proxy-media.ts";
import * as crossSpaceSearch from "./routes/search.ts";
import * as accessToken from "./routes/spaces/access-token.ts";
import * as accessTokens from "./routes/spaces/access-tokens.ts";
import * as aiChatSession from "./routes/spaces/ai-chat-session.ts";
import * as aiChatSessions from "./routes/spaces/ai-chat-sessions.ts";
import * as spaceAuditLogs from "./routes/spaces/audit-logs.ts";
import * as categories from "./routes/spaces/categories.ts";
import * as category from "./routes/spaces/category.ts";
import * as spaceComments from "./routes/spaces/comments.ts";
import * as document from "./routes/spaces/document.ts";
import * as documentAccess from "./routes/spaces/document-access.ts";
import * as documentBreadcrumbs from "./routes/spaces/document-breadcrumbs.ts";
import * as documentChildren from "./routes/spaces/document-children.ts";
import * as documentContributors from "./routes/spaces/document-contributors.ts";
import * as documentDiff from "./routes/spaces/document-diff.ts";
import * as documentEdit from "./routes/spaces/document-edit.ts";
import * as documentRevisions from "./routes/spaces/document-revisions.ts";
import * as documents from "./routes/spaces/documents.ts";
import * as documentsArchived from "./routes/spaces/documents-archived.ts";
import * as extension from "./routes/spaces/extension.ts";
import * as extensionAsset from "./routes/spaces/extension-assets.ts";
import * as extensionPackage from "./routes/spaces/extension-package.ts";
import * as extensions from "./routes/spaces/extensions.ts";
import * as integration from "./routes/spaces/integration.ts";
import * as integrationCallback from "./routes/spaces/integration-callback.ts";
import * as integrationConnect from "./routes/spaces/integration-connect.ts";
import * as integrationProxy from "./routes/spaces/integration-proxy.ts";
import * as integrations from "./routes/spaces/integrations.ts";
import * as jobRuns from "./routes/spaces/job-runs.ts";
import * as jobsRun from "./routes/spaces/jobs-run.ts";
import * as members from "./routes/spaces/members.ts";
import * as spaceNotificationPreference from "./routes/spaces/notification-preference.ts";
import * as permissions from "./routes/spaces/permissions.ts";
import * as permissionsMe from "./routes/spaces/permissions-me.ts";
import * as properties from "./routes/spaces/properties.ts";
import * as search from "./routes/spaces/search.ts";
import * as searchRebuild from "./routes/spaces/search-rebuild.ts";
import * as secret from "./routes/spaces/secret.ts";
import * as secrets from "./routes/spaces/secrets.ts";
import * as settingsAiProvider from "./routes/spaces/settings-ai-provider.ts";
import * as space from "./routes/spaces/space.ts";
import * as spaces from "./routes/spaces/spaces.ts";
import * as uploadFile from "./routes/spaces/upload-file.ts";
import * as uploads from "./routes/spaces/uploads.ts";
import * as workflowRun from "./routes/spaces/workflow-run.ts";
import * as workflowRuns from "./routes/spaces/workflow-runs.ts";
import * as workflowSchedule from "./routes/spaces/workflow-schedule.ts";
import * as workflowSchedules from "./routes/spaces/workflow-schedules.ts";
import * as urlMetadata from "./routes/url-metadata.ts";
import * as usersMe from "./routes/users/me.ts";
import * as usersSuggestions from "./routes/users/suggestions.ts";
import * as users from "./routes/users/users.ts";
import * as wellKnownCaldav from "./routes/well-known/caldav.ts";
import * as wellKnownVektor from "./routes/well-known/vektor.ts";
import type { ApiRouteModule } from "./server/types.ts";

export interface ApiRoute {
  /** Bracket-parameter path pattern, e.g. `/api/v1/spaces/[spaceId]`. */
  pattern: string;
  module: ApiRouteModule;
}

/**
 * All HTTP routes served by the Hono API. The router sorts by specificity so
 * order here does not matter — static segments beat params, params beat catch-alls.
 * Files under `routes/` are laid out flat: the pattern below is the only thing
 * that decides a URL, so a new route is a new file plus an entry here.
 */
export const apiRoutes: ApiRoute[] = [
  { pattern: "/.well-known/caldav", module: wellKnownCaldav },
  { pattern: "/.well-known/vektor", module: wellKnownVektor },

  { pattern: "/api/auth/[...all]", module: authAll },

  { pattern: "/api/v1/auth/cli", module: authCli },
  { pattern: "/api/v1/auth/cli/token", module: authCliToken },

  { pattern: "/api/v1/chat/acp", module: chatAcp },
  { pattern: "/api/v1/chat/completions", module: chatCompletions },

  { pattern: "/api/caldav/calendars/[userId]/[spaceId]/[eventId]", module: caldavEvent },
  { pattern: "/api/caldav/calendars/[userId]/[spaceId]", module: caldavCalendar },
  { pattern: "/api/caldav/calendars/[userId]", module: caldavCalendars },
  { pattern: "/api/caldav/principals/[userId]", module: caldavPrincipal },

  { pattern: "/api/v1/spaces", module: spaces },
  { pattern: "/api/v1/spaces/[spaceId]", module: space },
  { pattern: "/api/v1/spaces/[spaceId]/audit-logs", module: spaceAuditLogs },
  { pattern: "/api/v1/spaces/[spaceId]/members", module: members },
  {
    pattern: "/api/v1/spaces/[spaceId]/notification-preference",
    module: spaceNotificationPreference,
  },
  { pattern: "/api/v1/spaces/[spaceId]/properties", module: properties },

  { pattern: "/api/v1/spaces/[spaceId]/access-tokens", module: accessTokens },
  { pattern: "/api/v1/spaces/[spaceId]/access-tokens/[tokenId]", module: accessToken },

  { pattern: "/api/v1/spaces/[spaceId]/ai-chat/sessions", module: aiChatSessions },
  {
    pattern: "/api/v1/spaces/[spaceId]/ai-chat/sessions/[sessionId]",
    module: aiChatSession,
  },

  { pattern: "/api/v1/spaces/[spaceId]/categories", module: categories },
  { pattern: "/api/v1/spaces/[spaceId]/categories/[id]", module: category },

  { pattern: "/api/v1/spaces/[spaceId]/comments", module: spaceComments },

  { pattern: "/api/v1/spaces/[spaceId]/documents", module: documents },
  { pattern: "/api/v1/spaces/[spaceId]/documents/archived", module: documentsArchived },
  { pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]", module: document },
  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/access",
    module: documentAccess,
  },
  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/breadcrumbs",
    module: documentBreadcrumbs,
  },
  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/children",
    module: documentChildren,
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
    pattern: "/api/v1/spaces/[spaceId]/extensions/[extensionId]/package",
    module: extensionPackage,
  },
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

  { pattern: "/api/v1/spaces/[spaceId]/jobs/run", module: jobsRun },
  { pattern: "/api/v1/spaces/[spaceId]/jobs/runs", module: jobRuns },

  { pattern: "/api/v1/spaces/[spaceId]/permissions", module: permissions },
  { pattern: "/api/v1/spaces/[spaceId]/permissions/me", module: permissionsMe },

  { pattern: "/api/v1/spaces/[spaceId]/search", module: search },
  { pattern: "/api/v1/spaces/[spaceId]/search/rebuild", module: searchRebuild },

  { pattern: "/api/v1/spaces/[spaceId]/secrets", module: secrets },
  { pattern: "/api/v1/spaces/[spaceId]/secrets/[name]", module: secret },

  {
    pattern: "/api/v1/spaces/[spaceId]/settings/ai-provider",
    module: settingsAiProvider,
  },

  { pattern: "/api/v1/spaces/[spaceId]/uploads", module: uploads },
  { pattern: "/api/v1/spaces/[spaceId]/uploads/[...path]", module: uploadFile },

  { pattern: "/api/v1/spaces/[spaceId]/workflows/runs", module: workflowRuns },
  { pattern: "/api/v1/spaces/[spaceId]/workflows/runs/[runId]", module: workflowRun },
  { pattern: "/api/v1/spaces/[spaceId]/workflows/schedules", module: workflowSchedules },
  {
    pattern: "/api/v1/spaces/[spaceId]/workflows/schedules/[scheduleId]",
    module: workflowSchedule,
  },

  { pattern: "/api/v1/proxy-media", module: proxyMedia },
  { pattern: "/api/v1/search", module: crossSpaceSearch },
  { pattern: "/api/v1/url-metadata", module: urlMetadata },
  { pattern: "/api/v1/users", module: users },
  { pattern: "/api/v1/users/me", module: usersMe },
  { pattern: "/api/v1/users/suggestions", module: usersSuggestions },
];
