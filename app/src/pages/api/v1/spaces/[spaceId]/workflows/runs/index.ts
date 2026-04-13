import type { APIRoute } from "astro";
import { getDocument } from "#db/documents.ts";
import { getPublishedContent } from "#db/revisions.ts";
import { getExtension } from "#db/extensions.ts";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#db/api.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";
import {
  createRun,
  getRun,
  latestRunByDoc,
  runs,
} from "../../../../../../../jobs/runStore.ts";
import {
  executeWorkflow,
  type WorkflowDefinition,
} from "../../../../../../../jobs/workflow.ts";
import { activeTraceHeaders } from "#observability/otel.ts";
import { appLogger } from "#observability/logger.ts";

/**
 * GET /api/v1/spaces/:spaceId/workflows/runs?documentId=<id>
 * With documentId: returns { runId, status } for the latest run of that document, or 404.
 * Without documentId: returns { runs: [{ runId, documentId, status, documentTitle }] } for runs in the space.
 * Optional query: sourceExtensionId filters runs created directly by that extension.
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer");

    const documentId = context.url.searchParams.get("documentId");
    const sourceExtensionId = context.url.searchParams.get("sourceExtensionId");

    if (documentId) {
      const runId = latestRunByDoc.get(documentId);
      if (!runId) return notFoundResponse("Run");
      const run = runs.get(runId);
      if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");
      return jsonResponse({ runId, status: run.status });
    }

    // List all runs for this space, newest first
    const allRuns = await Promise.all(
      [...runs.entries()]
        .filter(([, run]) =>
          run.spaceId === spaceId &&
          (!sourceExtensionId || run.sourceExtensionId === sourceExtensionId)
        )
        .map(async ([runId, run]) => {
          const doc = await getDocument(spaceId, run.documentId);
          return {
            runId,
            documentId: run.documentId,
            documentSlug: doc?.slug ?? null,
            documentTitle: doc?.properties.title ?? run.documentId,
            status: run.status,
            createdAt: run.createdAt.toISOString(),
            sourceExtensionId: run.sourceExtensionId,
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
        fromRunId?: string;
        fromNodeId?: string;
        inputs?: Record<string, unknown>;
        sourceExtensionId?: string;
      }>(context.request);
      const { documentId, fromRunId, fromNodeId, inputs, sourceExtensionId } = body;
      if (documentId) span?.setAttribute("wiki.document.id", documentId);

      if (!documentId) return badRequestResponse("documentId is required");

      const doc = await getDocument(spaceId, documentId);
      if (!doc) return notFoundResponse("Document");
      if (doc.type !== "workflow") {
        return badRequestResponse("Document type must be 'workflow'");
      }

      const content =
        doc.publishedRev !== null
          ? ((await getPublishedContent(spaceId, documentId)) ?? doc.content)
          : doc.content;

      let definition: WorkflowDefinition;
      try {
        definition = JSON.parse(content ?? "{}") as WorkflowDefinition;
      } catch {
        return badRequestResponse("Workflow document content is not valid JSON");
      }

      // Validate each node's extensionId + jobId exists
      for (const [nodeId, node] of Object.entries(definition)) {
        const ext = await getExtension(spaceId, node.extensionId);
        if (!ext) {
          return badRequestResponse(
            `Node "${nodeId}": extension "${node.extensionId}" not found`,
          );
        }
        const job = ext.manifest.jobs?.find((j) => j.id === node.jobId);
        if (!job) {
          return badRequestResponse(
            `Node "${nodeId}": job "${node.jobId}" not found in extension "${node.extensionId}"`,
          );
        }
      }

      // Build pre-seeded outputs when restarting from a specific node
      let preSeeded: Map<string, Record<string, unknown>> | undefined;
      if (fromRunId && fromNodeId) {
        const prevRun = getRun(fromRunId);
        if (!prevRun) return notFoundResponse("Previous run");
        if (prevRun.spaceId !== spaceId || prevRun.documentId !== documentId) {
          return badRequestResponse("Previous run does not belong to this workflow");
        }
        if (!definition[fromNodeId]) {
          return badRequestResponse(`Node "${fromNodeId}" not in workflow`);
        }
        if (prevRun.nodes.get(fromNodeId)?.status !== "failed") {
          return badRequestResponse(`Node "${fromNodeId}" did not fail in previous run`);
        }

        // Topological order to find nodes that come before fromNodeId
        const inDegree = new Map<string, number>();
        const adj = new Map<string, string[]>();
        for (const nid of Object.keys(definition)) {
          inDegree.set(nid, definition[nid].depends.length);
          adj.set(nid, []);
        }
        for (const [nid, node] of Object.entries(definition)) {
          for (const dep of node.depends) {
            const dependents = adj.get(dep);
            if (dependents) dependents.push(nid);
          }
        }
        const queue: string[] = [];
        for (const [nid, deg] of inDegree) {
          if (deg === 0) queue.push(nid);
        }
        const order: string[] = [];
        while (queue.length > 0) {
          const nid = queue.shift();
          if (!nid) break;
          order.push(nid);
          for (const dep of adj.get(nid) ?? []) {
            const currentDegree = inDegree.get(dep);
            if (currentDegree === undefined) continue;
            const nd = currentDegree - 1;
            inDegree.set(dep, nd);
            if (nd === 0) queue.push(dep);
          }
        }

        // Collect ancestors of fromNodeId (everything it transitively depends on)
        const ancestors = new Set<string>();
        const stack = [...definition[fromNodeId].depends];
        while (stack.length > 0) {
          const nid = stack.pop();
          if (!nid) break;
          if (ancestors.has(nid)) continue;
          ancestors.add(nid);
          stack.push(...definition[nid].depends);
        }

        preSeeded = new Map();
        for (const nid of ancestors) {
          const nodeState = prevRun.nodes.get(nid);
          if (nodeState?.status === "completed" && nodeState.outputs) {
            preSeeded.set(nid, nodeState.outputs);
          }
        }
      }

      const runId = createRun(
        spaceId,
        documentId,
        Object.keys(definition),
        initiatedByUserId,
        sourceExtensionId ?? null,
      );
      const traceHeaders = activeTraceHeaders();

      // Fire and forget — errors are recorded in run state
      executeWorkflow(spaceId, runId, definition, preSeeded, {
        traceparent: traceHeaders.traceparent,
        tracestate: traceHeaders.tracestate,
        runtimeInputs: inputs,
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
