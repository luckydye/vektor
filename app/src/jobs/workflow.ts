import { getExtension, getExtensionPackage } from "../db/extensions.ts";
import { otelMetrics, withSpan } from "../observability/otel.ts";
import { runJob } from "./scheduler.ts";
import { getRun, setNodeStatus, appendNodeLog, finalizeRun } from "./runStore.ts";

export type WorkflowInput = { key: string; value: unknown };

export type WorkflowDefinition = Record<
  string,
  {
    extensionId: string;
    jobId: string;
    inputs: WorkflowInput[];
    depends: string[];
    disabled?: boolean;
  }
>;


const meter = otelMetrics.getMeter("wiki.workflows");
const workflowRunsCounter = meter.createCounter("wiki_workflow_runs_total");
const workflowRunDurationMs = meter.createHistogram("wiki_workflow_run_duration_ms", {
  unit: "ms",
});
const workflowNodeDurationMs = meter.createHistogram("wiki_workflow_node_duration_ms", {
  unit: "ms",
});

/**
 * Run a workflow definition. Called without await after returning runId.
 * Resolves execution order via topological sort (Kahn's algorithm).
 * Each node's outputs are merged into dependent nodes' inputs (explicit inputs take precedence).
 */
export async function executeWorkflow(
  spaceId: string,
  runId: string,
  definition: WorkflowDefinition,
  preSeeded?: Map<string, Record<string, unknown>>,
  options?: {
    traceparent?: string | null;
    tracestate?: string | null;
    runtimeInputs?: Record<string, unknown>;
  },
): Promise<void> {
  const workflowStart = Date.now();
  const nodeIds = Object.keys(definition);

  await withSpan(
    "wiki.workflow.run",
    {
      traceparent: options?.traceparent,
      tracestate: options?.tracestate,
      attributes: {
        "wiki.space.id": spaceId,
        "wiki.workflow.run_id": runId,
        "wiki.workflow.node_count": nodeIds.length,
      },
    },
    async () => {
      // Validate: all depends entries reference existing node IDs
      for (const [nodeId, node] of Object.entries(definition)) {
        for (const dep of node.depends) {
          if (!definition[dep]) {
            throw new Error(`Node "${nodeId}" depends on unknown node "${dep}"`);
          }
        }
      }

      // Topological sort via Kahn's algorithm
      const inDegree = new Map<string, number>();
      const adj = new Map<string, string[]>(); // dep -> its dependents

      for (const nodeId of nodeIds) {
        inDegree.set(nodeId, definition[nodeId].depends.length);
        adj.set(nodeId, []);
      }
      for (const [nodeId, node] of Object.entries(definition)) {
        for (const dep of node.depends) {
          const dependents = adj.get(dep);
          if (dependents) dependents.push(nodeId);
        }
      }

      const queue: string[] = [];
      for (const [nodeId, deg] of inDegree) {
        if (deg === 0) queue.push(nodeId);
      }

      const order: string[] = [];
      while (queue.length > 0) {
        const nodeId = queue.shift();
        if (!nodeId) break;
        order.push(nodeId);
        for (const dependent of adj.get(nodeId) ?? []) {
          const currentDeg = inDegree.get(dependent);
          if (currentDeg === undefined) continue;
          const newDeg = currentDeg - 1;
          inDegree.set(dependent, newDeg);
          if (newDeg === 0) queue.push(dependent);
        }
      }

      if (order.length !== nodeIds.length) {
        throw new Error("Workflow definition contains a dependency cycle");
      }

      const run = getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      run.status = "running";

      const controller = new AbortController();
      run.abort = () => controller.abort();

      const nodeOutputs = new Map<string, Record<string, unknown>>();

      for (const nodeId of order) {
        if (controller.signal.aborted) break;
        const nodeDef = definition[nodeId];
        const nodeStartedAt = Date.now();

        if (nodeDef.disabled) {
          setNodeStatus(runId, nodeId, { status: "skipped", completedAt: new Date() });
          nodeOutputs.set(nodeId, {});
          workflowNodeDurationMs.record(Date.now() - nodeStartedAt, {
            extension_id: nodeDef.extensionId,
            job_id: nodeDef.jobId,
            status: "skipped",
          });
          continue;
        }

        const seeded = preSeeded?.get(nodeId);
        if (seeded) {
          nodeOutputs.set(nodeId, seeded);
          setNodeStatus(runId, nodeId, {
            status: "completed",
            outputs: seeded,
            completedAt: new Date(),
          });
          workflowNodeDurationMs.record(Date.now() - nodeStartedAt, {
            extension_id: nodeDef.extensionId,
            job_id: nodeDef.jobId,
            status: "seeded",
          });
          continue;
        }

        // Build resolved inputs: runtime inputs as baseline, then inherited dependency outputs,
        // then explicit node inputs (highest priority).
        // JobOutputValue typed objects are unwrapped to their raw scalar before passing to the next job.
        const resolvedInputs: Record<string, unknown> = { ...(options?.runtimeInputs ?? {}) };
        for (const depId of nodeDef.depends) {
          for (const [key, val] of Object.entries(nodeOutputs.get(depId) ?? {})) {
            const typed = val as { type?: string; url?: string; value?: unknown };
            if (typed.type === "file") resolvedInputs[key] = typed.url;
            else if (typed.type === "text") resolvedInputs[key] = typed.value;
            else resolvedInputs[key] = val;
          }
        }
        for (const { key, value } of nodeDef.inputs) {
          if (value !== "") resolvedInputs[key] = value;
        }

        setNodeStatus(runId, nodeId, {
          status: "running",
          inputs: resolvedInputs,
          startedAt: new Date(),
        });

        try {
          const outputs = await withSpan(
            "wiki.workflow.node",
            {
              attributes: {
                "wiki.workflow.run_id": runId,
                "wiki.workflow.node_id": nodeId,
                "wiki.extension.id": nodeDef.extensionId,
                "wiki.job.id": nodeDef.jobId,
              },
            },
            async () => {
              const ext = await getExtension(spaceId, nodeDef.extensionId);
              if (!ext) throw new Error(`Extension not found: ${nodeDef.extensionId}`);

              const jobDef = ext.manifest.jobs?.find((j) => j.id === nodeDef.jobId);
              if (!jobDef) {
                throw new Error(
                  `Job "${nodeDef.jobId}" not found in extension "${nodeDef.extensionId}"`,
                );
              }

              const zipBuffer = await getExtensionPackage(spaceId, nodeDef.extensionId);
              if (!zipBuffer)
                throw new Error(`Extension package not found: ${nodeDef.extensionId}`);

              return await runJob(
                zipBuffer,
                jobDef.entry,
                resolvedInputs,
                spaceId,
                (message) => appendNodeLog(runId, nodeId, message),
                {
                  signal: controller.signal,
                  initiatedByUserId: run.initiatedByUserId,
                  jobType: "workflow_node",
                  jobId: nodeDef.jobId,
                },
              );
            },
          );

          nodeOutputs.set(nodeId, outputs);
          setNodeStatus(runId, nodeId, {
            status: "completed",
            outputs,
            completedAt: new Date(),
          });
          workflowNodeDurationMs.record(Date.now() - nodeStartedAt, {
            extension_id: nodeDef.extensionId,
            job_id: nodeDef.jobId,
            status: "completed",
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          setNodeStatus(runId, nodeId, {
            status: "failed",
            error,
            completedAt: new Date(),
          });
          workflowNodeDurationMs.record(Date.now() - nodeStartedAt, {
            extension_id: nodeDef.extensionId,
            job_id: nodeDef.jobId,
            status: "failed",
          });
          run.status = "failed";
          finalizeRun(runId);
          workflowRunsCounter.add(1, { status: "failed" });
          workflowRunDurationMs.record(Date.now() - workflowStart, { status: "failed" });
          return;
        }
      }

      finalizeRun(runId);
      workflowRunsCounter.add(1, { status: run.status });
      workflowRunDurationMs.record(Date.now() - workflowStart, { status: run.status });
    },
  );
}
