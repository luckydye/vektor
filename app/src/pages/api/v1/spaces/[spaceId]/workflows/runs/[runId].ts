import type { APIRoute } from "astro";
import { getDocument } from "#db/documents.ts";
import { getPublishedContent } from "#db/revisions.ts";
import {
  errorResponse,
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";
import { getRun, cancelRun } from "../../../../../../../jobs/runStore.ts";
import type { WorkflowDefinition } from "../../../../../../../jobs/workflow.ts";

function getTerminalNodeIds(definition: WorkflowDefinition): string[] {
  const enabledEntries = Object.entries(definition).filter(([, node]) => !node.disabled);
  if (enabledEntries.length === 0) return [];

  const dependedOn = new Set<string>();
  for (const [, node] of enabledEntries) {
    for (const dep of node.depends) dependedOn.add(dep);
  }

  return enabledEntries
    .map(([nodeId]) => nodeId)
    .filter((nodeId) => !dependedOn.has(nodeId));
}

async function getWorkflowOutput(spaceId: string, documentId: string, nodes: Record<string, unknown>) {
  const doc = await getDocument(spaceId, documentId);
  if (!doc || doc.type !== "workflow") return null;

  const content =
    doc.publishedRev !== null
      ? ((await getPublishedContent(spaceId, documentId)) ?? doc.content)
      : doc.content;

  let definition: WorkflowDefinition;
  try {
    definition = JSON.parse(content ?? "{}") as WorkflowDefinition;
  } catch {
    return null;
  }

  const terminalNodeIds = getTerminalNodeIds(definition);
  if (terminalNodeIds.length === 0) return null;

  const output = terminalNodeIds.reduce<Record<string, unknown>>((acc, nodeId) => {
    const nodeOutputs = (nodes[nodeId] as { outputs?: Record<string, unknown> | null } | undefined)
      ?.outputs;
    if (nodeOutputs && typeof nodeOutputs === "object") {
      Object.assign(acc, nodeOutputs);
    }
    return acc;
  }, {});

  return Object.keys(output).length > 0 ? output : null;
}

/**
 * GET /api/v1/spaces/:spaceId/workflows/runs/:runId
 * Returns the current state of a workflow run.
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const runId = requireParam(context.params, "runId");

    await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer");

    const run = getRun(runId);
    if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");

    const nodes: Record<string, unknown> = {};
    for (const [nodeId, nodeState] of run.nodes) {
      nodes[nodeId] = {
        status: nodeState.status,
        inputs: nodeState.inputs,
        outputs: nodeState.outputs,
        error: nodeState.error,
        logs: nodeState.logs,
        startedAt: nodeState.startedAt?.toISOString() ?? null,
        completedAt: nodeState.completedAt?.toISOString() ?? null,
      };
    }

    const output = await getWorkflowOutput(spaceId, run.documentId, nodes);

    return jsonResponse({ status: run.status, nodes, output });
  }, "Failed to get run");

function cancelWorkflowRun(context: Parameters<APIRoute>[0]) {
  return withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.params, "spaceId");
      const runId = requireParam(context.params, "runId");
      await verifySpaceRole(spaceId, user.id, "editor");
      const run = getRun(runId);
      if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");
      cancelRun(runId);
      return jsonResponse({ ok: true });
    },
    {
      fallbackMessage: "Failed to cancel run",
      onError: () => errorResponse("Failed to cancel run", 500),
    },
  );
}

export const POST: APIRoute = (context) => cancelWorkflowRun(context);

export const DELETE: APIRoute = (context) => cancelWorkflowRun(context);
