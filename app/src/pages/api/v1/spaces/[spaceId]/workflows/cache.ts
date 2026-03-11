import type { APIRoute } from "astro";
import { getDocument } from "#db/documents.ts";
import { getPublishedContent } from "#db/revisions.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { clearJobCache } from "../../../../../../jobs/scheduler.ts";
import {
  getWorkflowCacheScopeIds,
  type WorkflowDefinition,
} from "../../../../../../jobs/workflow.ts";

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "editor");

    const body = await parseJsonBody<{ documentId?: string }>(context.request);
    if (!body.documentId) return badRequestResponse("documentId is required");

    const doc = await getDocument(spaceId, body.documentId);
    if (!doc) return notFoundResponse("Document");
    if (doc.type !== "workflow") {
      return badRequestResponse("Document type must be 'workflow'");
    }

    const content =
      doc.publishedRev !== null
        ? ((await getPublishedContent(spaceId, body.documentId)) ?? doc.content)
        : doc.content;

    let definition: WorkflowDefinition;
    try {
      definition = JSON.parse(content ?? "{}") as WorkflowDefinition;
    } catch {
      return badRequestResponse("Workflow document content is not valid JSON");
    }

    const scopes = getWorkflowCacheScopeIds(spaceId, definition);
    await Promise.all(scopes.map((scope) => clearJobCache(scope)));

    return jsonResponse({ clearedScopes: scopes.length });
  }, "Failed to clear workflow cache");
