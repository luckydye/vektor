import type { APIRoute } from "astro";
import { filterReadableResources, getUserGroups, ResourceType } from "#db/acl.ts";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#db/api.ts";
import { getDocument } from "#db/documents.ts";
import {
  createRun,
  ensureSpaceRecovered,
  getLatestRunIdForDoc,
  getRunForRead,
  listRuns,
} from "#jobs/runStore.ts";
import { executeWorkflowScript } from "#jobs/workflowScript.ts";
import { appLogger } from "#observability/logger.ts";
import { activeTraceHeaders } from "#observability/otel.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";

/**
 * GET /api/v1/spaces/:spaceId/workflows/runs?documentId=<id>
 * With documentId: returns { runId, status } for the latest run of that document, or 404.
 * Without documentId: returns { runs: [{ runId, documentId, status, documentTitle }] } for runs in the space.
 * Optional query: sourceExtensionId filters runs created directly by that extension.
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer");
    // A run is keyed to a document; its status/title must only be visible to a
    // caller who can read that document. User-less system tokens (userId null)
    // see everything.
    const aclUserId = auth.type === "user" ? auth.user.id : auth.userId;
    const viewerGroups = aclUserId ? await getUserGroups(aclUserId) : undefined;
    const canReadDocument = async (docId: string): Promise<boolean> => {
      if (!aclUserId) return true;
      const readable = await filterReadableResources(
        spaceId,
        ResourceType.DOCUMENT,
        [docId],
        aclUserId,
        viewerGroups,
      );
      return readable.has(docId);
    };

    const documentId = context.url.searchParams.get("documentId");
    const sourceExtensionId = context.url.searchParams.get("sourceExtensionId");

    await ensureSpaceRecovered(spaceId);

    if (documentId) {
      const runId = await getLatestRunIdForDoc(spaceId, documentId);
      if (!runId) return notFoundResponse("Run");
      const run = await getRunForRead(spaceId, runId);
      if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");
      if (!(await canReadDocument(run.documentId))) return notFoundResponse("Run");
      return jsonResponse({ runId, status: run.status });
    }

    // List all runs for this space, newest first
    const spaceRuns = (await listRuns(spaceId, { sourceExtensionId })).map(
      ({ runId, run }) => [runId, run] as const,
    );
    const readableRuns: typeof spaceRuns = [];
    for (const entry of spaceRuns) {
      if (await canReadDocument(entry[1].documentId)) readableRuns.push(entry);
    }
    const allRuns = await Promise.all(
      readableRuns.map(async ([runId, run]) => {
        const doc = await getDocument(spaceId, run.documentId);
        const nodeList = [...run.nodes.values()];
        const startedAt = nodeList.reduce<Date | null>((min, n) => {
          if (!n.startedAt) return min;
          return min === null || n.startedAt < min ? n.startedAt : min;
        }, null);
        const finishedAt = nodeList.reduce<Date | null>((max, n) => {
          if (!n.completedAt) return max;
          return max === null || n.completedAt > max ? n.completedAt : max;
        }, null);
        const completedNodes = nodeList.filter(
          (n) =>
            n.status === "completed" || n.status === "failed" || n.status === "cancelled",
        ).length;
        return {
          runId,
          documentId: run.documentId,
          documentSlug: doc?.slug ?? null,
          documentTitle: doc?.properties.title ?? run.documentId,
          status: run.status,
          createdAt: run.createdAt.toISOString(),
          startedAt: startedAt?.toISOString() ?? null,
          finishedAt: finishedAt?.toISOString() ?? null,
          totalNodes: nodeList.length,
          completedNodes,
          sourceExtensionId: run.sourceExtensionId,
          runtimeInputs: run.runtimeInputs,
        };
      }),
    );

    return jsonResponse({ runs: allRuns });
  }, "Failed to get runs");

/**
 * POST /api/v1/spaces/:spaceId/workflows/runs
 * Body: { documentId: string }
 * Returns 202 { runId } immediately; execution proceeds in the background.
 */
export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async (span) => {
      const spaceId = requireParam(context.params, "spaceId");
      const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");
      const initiatedByUserId = auth.type === "user" ? auth.user.id : auth.userId;

      const body = await parseJsonBody<{
        documentId?: string;
        inputs?: Record<string, unknown>;
        sourceExtensionId?: string;
      }>(context.request);
      const { documentId, inputs, sourceExtensionId } = body;
      if (documentId) span?.setAttribute("wiki.document.id", documentId);

      if (!documentId) return badRequestResponse("documentId is required");

      const doc = await getDocument(spaceId, documentId);
      if (!doc) return notFoundResponse("Document");
      if (doc.type !== "workflow") {
        return badRequestResponse("Document type must be 'workflow'");
      }

      // Always run the current draft — workflows are scripts, not versioned publications.
      const code = doc.content;

      if (!code?.trim()) {
        return badRequestResponse("Workflow script is empty");
      }

      const runId = createRun(
        spaceId,
        documentId,
        [],
        initiatedByUserId,
        sourceExtensionId ?? null,
        inputs ?? {},
      );
      const traceHeaders = activeTraceHeaders();

      // Fire and forget — errors are recorded in run state
      executeWorkflowScript(spaceId, runId, code, {
        runtimeInputs: inputs,
        traceparent: traceHeaders.traceparent,
        tracestate: traceHeaders.tracestate,
      }).catch(() => {});

      return jsonResponse({ runId }, 202);
    },
    {
      fallbackMessage: "Failed to start workflow run",
      telemetry: {
        context,
        spanName: "api.workflows.runs.start",
        attributes: {
          "http.method": "POST",
          "http.route": "/api/v1/spaces/:spaceId/workflows/runs",
        },
      },
      onError: (error) => {
        appLogger.error("Start workflow run error", {
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResponse("Failed to start workflow run", 500);
      },
    },
  );
