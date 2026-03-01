export type NodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type NodeState = {
  status: NodeStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  error: string | null;
  logs: string[];
  startedAt: Date | null;
  completedAt: Date | null;
};

export type RunState = {
  status: NodeStatus;
  nodes: Map<string, NodeState>;
  spaceId: string;
  documentId: string;
  initiatedByUserId: string | null;
  abort?: () => void;
};

export const runs = new Map<string, RunState>();
export const latestRunByDoc = new Map<string, string>();

export function createRun(
  spaceId: string,
  documentId: string,
  nodeIds: string[],
  initiatedByUserId: string | null = null,
): string {
  const runId = crypto.randomUUID();
  const nodes = new Map<string, NodeState>();
  for (const id of nodeIds) {
    nodes.set(id, {
      status: "pending",
      inputs: {},
      outputs: null,
      error: null,
      logs: [],
      startedAt: null,
      completedAt: null,
    });
  }
  runs.set(runId, { status: "pending", nodes, spaceId, documentId, initiatedByUserId });
  latestRunByDoc.set(documentId, runId);
  return runId;
}

export function getRun(runId: string): RunState | undefined {
  return runs.get(runId);
}

export function setNodeStatus(
  runId: string,
  nodeId: string,
  update: Partial<NodeState>,
): void {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const node = run.nodes.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  Object.assign(node, update);
}

export function appendNodeLog(runId: string, nodeId: string, message: string): void {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const node = run.nodes.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  node.logs.push(message);
}

export function finalizeRun(runId: string): void {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status === "cancelled") return;
  const anyFailed = [...run.nodes.values()].some((n) => n.status === "failed");
  run.status = anyFailed ? "failed" : "completed";
}

export function cancelRun(runId: string): void {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.status = "cancelled";
  run.abort?.();
  for (const node of run.nodes.values()) {
    if (node.status === "pending" || node.status === "running") {
      node.status = "cancelled";
      node.completedAt = new Date();
    }
  }
}
