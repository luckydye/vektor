import { openSpaceStore } from "#db/client/store.ts";
import { authenticateJobTokenOrSpaceRole } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { filterReadableResources, getUserGroups } from "#acl/store.ts";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getDocument, getDocumentsByIds } from "#db/space/documents.ts";
import { propertyValueToText } from "#documents/properties.ts";
import {
  ensureSpaceRecovered,
  getLatestRunIdForDoc,
  getRunForRead,
  listRuns,
} from "#jobs/runStore.ts";
import { startWorkflowRun } from "#jobs/workflowRuns.ts";
import { readRunResumeState, type WorkflowStepCache } from "#jobs/workflowStepCache.ts";
import { appLogger } from "#observability/logger.ts";

/**
 * GET /api/v1/spaces/:spaceId/workflows/runs?documentId=<id>
 * With documentId: returns { runId, status } for the latest run of that document, or 404.
 * Without documentId: returns { runs: [...], nextCursor } for runs in the space, cursor-paginated
 * (pass the previous response's nextCursor back as ?cursor= to fetch the next page).
 * Optional query: sourceExtensionId filters runs created directly by that extension.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const store = await openSpaceStore(spaceId);
    const auth = await authenticateJobTokenOrSpaceRole(
      context,
      spaceId,
      Permission.VIEWER,
    );
    // A run is keyed to a document; its status/title must only be visible to a
    // caller who can read that document. User-less system tokens (userId null)
    // see everything.
    const aclUserId = auth.type === "user" ? auth.user.id : auth.userId;
    const viewerGroups = aclUserId ? await getUserGroups(aclUserId) : undefined;
    /**
     * Readable ids out of a whole set at once. `filterReadableResources`
     * rebuilds the space's ACL picture per call — the document tree included —
     * so asking it about one id at a time costs that walk once per document.
     */
    const readableDocuments = async (docIds: string[]): Promise<Set<string>> => {
      if (!aclUserId) return new Set(docIds);
      return await filterReadableResources(
        spaceId,
        ResourceType.DOCUMENT,
        [...new Set(docIds)],
        { userId: aclUserId, userGroups: viewerGroups },
      );
    };

    const documentId = new URL(context.req.url).searchParams.get("documentId");
    const sourceExtensionId = new URL(context.req.url).searchParams.get(
      "sourceExtensionId",
    );
    const filterDocumentId =
      new URL(context.req.url).searchParams.get("filterDocumentId") ?? undefined;

    await ensureSpaceRecovered(spaceId);

    if (documentId) {
      const runId = await getLatestRunIdForDoc(spaceId, documentId);
      if (!runId) return notFoundResponse("Run");
      const run = await getRunForRead(spaceId, runId);
      if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");
      const readable = await readableDocuments([run.documentId]);
      if (!readable.has(run.documentId)) return notFoundResponse("Run");
      return jsonResponse({ runId, status: run.status });
    }

    const limitParam = new URL(context.req.url).searchParams.get("limit");
    const limitNum = limitParam ? parseInt(limitParam, 10) : NaN;
    const limit =
      Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, 200) : 20;
    const cursor = new URL(context.req.url).searchParams.get("cursor") || undefined;

    // List runs for this space, newest first, cursor-paginated at the DB
    // level — never the full run history. filterDocumentId narrows to one document.
    const { runs: spaceRuns, nextCursor } = await listRuns(spaceId, {
      sourceExtensionId,
      documentId: filterDocumentId,
      cursor,
      limit,
    });
    const readable = await readableDocuments(
      spaceRuns.map((entry) => entry.run.documentId),
    );
    const readableRuns = spaceRuns.filter((entry) => readable.has(entry.run.documentId));
    const documentsById = await getDocumentsByIds(
      store,
      readableRuns.map((entry) => entry.run.documentId),
    );

    const allRuns = readableRuns.map(({ runId, run }) => {
      const doc = documentsById.get(run.documentId);
      return {
        runId,
        documentId: run.documentId,
        documentSlug: doc?.slug ?? null,
        documentTitle: doc?.properties.title
          ? propertyValueToText(doc.properties.title)
          : run.documentId,
        status: run.status,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.completedAt?.toISOString() ?? null,
        sourceExtensionId: run.sourceExtensionId,
        runtimeInputs: run.runtimeInputs,
      };
    });

    return jsonResponse({ runs: allRuns, limit, nextCursor });
  }, "Failed to get runs");

/**
 * POST /api/v1/spaces/:spaceId/workflows/runs
 * Body: { documentId: string }
 * Returns 202 { runId } immediately; execution proceeds in the background.
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      const store = await openSpaceStore(spaceId);
      const auth = await authenticateJobTokenOrSpaceRole(
        context,
        spaceId,
        Permission.EDITOR,
      );
      const initiatedByUserId = auth.type === "user" ? auth.user.id : auth.userId;

      const body = await parseJsonBody<{
        documentId?: string;
        inputs?: Record<string, unknown>;
        sourceExtensionId?: string;
        resumeFromRunId?: string;
      }>(context.req.raw);
      const { sourceExtensionId, resumeFromRunId } = body;

      // Resume-from-failure: inherit the prior run's document + inputs and seed
      // its step cache so completed steps replay instead of re-executing. The
      // body may still override documentId/inputs.
      let documentId = body.documentId;
      let inputs = body.inputs;
      let seedCache: WorkflowStepCache | undefined;
      if (resumeFromRunId) {
        await ensureSpaceRecovered(spaceId);
        const priorRun = await getRunForRead(spaceId, resumeFromRunId);
        if (!priorRun) return notFoundResponse("Run");
        if (priorRun.status === "pending" || priorRun.status === "running") {
          return badRequestResponse("Cannot resume a run that is still in progress");
        }
        // The inputs come from the run's resume artifact, not its document
        // properties: the stored properties are summarized for display (secrets
        // redacted, long values truncated), so resuming from them would run the
        // workflow with corrupted inputs and miss every cached step.
        const resumeState = await readRunResumeState(spaceId, resumeFromRunId);
        if (!resumeState) {
          return badRequestResponse(
            "This run has no resume state; start a new run instead",
          );
        }
        documentId ??= priorRun.documentId;
        inputs ??= resumeState.inputs;
        seedCache = resumeState.steps;
      }

      if (!documentId) return badRequestResponse("documentId is required");

      const doc = await getDocument(store, documentId);
      if (!doc) return notFoundResponse("Document");
      if (doc.type !== "workflow") {
        return badRequestResponse("Document type must be 'workflow'");
      }

      const runId = await startWorkflowRun(spaceId, documentId, {
        initiatedByUserId,
        sourceExtensionId,
        runtimeInputs: inputs,
        seedCache,
      });

      return jsonResponse({ runId }, 202);
    },
    {
      fallbackMessage: "Failed to start workflow run",
      onError: (error) => {
        appLogger.error("Start workflow run error", {
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResponse("Failed to start workflow run", 500);
      },
    },
  );
