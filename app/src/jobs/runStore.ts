import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createId } from "../db/ids.ts";

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

type PersistedNodeState = Omit<NodeState, "startedAt" | "completedAt"> & {
  startedAt: string | null;
  completedAt: string | null;
};

type PersistedRunState = Omit<RunState, "nodes" | "abort"> & {
  nodes: Record<string, PersistedNodeState>;
};

type PersistedRunStore = {
  runs: Record<string, PersistedRunState>;
  latestRunByDoc: Record<string, string>;
};

export const runs = new Map<string, RunState>();
export const latestRunByDoc = new Map<string, string>();

export const RUN_STORE_RECOVERY_ERROR =
  "Workflow process restarted before this run completed";

let runStoreFilePath = process.env.VEKTOR_WORKFLOW_RUN_STORE_FILE ??
  join(tmpdir(), "vektor-workflow-runs.json");

function ensureRunStoreDirectory(): void {
  mkdirSync(dirname(runStoreFilePath), { recursive: true });
}

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function deserializeDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function serializeRun(run: RunState): PersistedRunState {
  return {
    status: run.status,
    spaceId: run.spaceId,
    documentId: run.documentId,
    initiatedByUserId: run.initiatedByUserId,
    nodes: Object.fromEntries(
      [...run.nodes.entries()].map(([nodeId, node]) => [
        nodeId,
        {
          status: node.status,
          inputs: node.inputs,
          outputs: node.outputs,
          error: node.error,
          logs: node.logs,
          startedAt: serializeDate(node.startedAt),
          completedAt: serializeDate(node.completedAt),
        },
      ]),
    ),
  };
}

function deserializeRun(serialized: PersistedRunState): RunState {
  return {
    status: serialized.status,
    spaceId: serialized.spaceId,
    documentId: serialized.documentId,
    initiatedByUserId: serialized.initiatedByUserId,
    nodes: new Map(
      Object.entries(serialized.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          status: node.status,
          inputs: node.inputs,
          outputs: node.outputs,
          error: node.error,
          logs: node.logs,
          startedAt: deserializeDate(node.startedAt),
          completedAt: deserializeDate(node.completedAt),
        },
      ]),
    ),
  };
}

function persistRunStore(): void {
  ensureRunStoreDirectory();
  const tempFilePath = `${runStoreFilePath}.${process.pid}.tmp`;
  const serialized: PersistedRunStore = {
    runs: Object.fromEntries([...runs.entries()].map(([runId, run]) => [runId, serializeRun(run)])),
    latestRunByDoc: Object.fromEntries(latestRunByDoc),
  };
  writeFileSync(tempFilePath, JSON.stringify(serialized), "utf-8");
  renameSync(tempFilePath, runStoreFilePath);
}

function recoverInterruptedRuns(): void {
  const recoveredAt = new Date();
  let changed = false;
  for (const run of runs.values()) {
    let runWasInterrupted = run.status === "pending" || run.status === "running";
    for (const node of run.nodes.values()) {
      if (node.status === "running") {
        node.status = "failed";
        node.error = RUN_STORE_RECOVERY_ERROR;
        node.completedAt = node.completedAt ?? recoveredAt;
        runWasInterrupted = true;
        changed = true;
        continue;
      }
      if (node.status === "pending") {
        node.status = "cancelled";
        node.completedAt = node.completedAt ?? recoveredAt;
        runWasInterrupted = true;
        changed = true;
      }
    }
    if (!runWasInterrupted) continue;
    run.status = "failed";
    changed = true;
  }
  if (changed) persistRunStore();
}

export function reloadRunStoreFromDisk(): void {
  runs.clear();
  latestRunByDoc.clear();
  if (!existsSync(runStoreFilePath)) return;
  const serialized = JSON.parse(readFileSync(runStoreFilePath, "utf-8")) as PersistedRunStore;
  for (const [runId, run] of Object.entries(serialized.runs)) {
    runs.set(runId, deserializeRun(run));
  }
  for (const [documentId, runId] of Object.entries(serialized.latestRunByDoc)) {
    latestRunByDoc.set(documentId, runId);
  }
  recoverInterruptedRuns();
}

export function setRunStoreFilePathForTests(filePath: string): void {
  runStoreFilePath = filePath;
  reloadRunStoreFromDisk();
}

export function clearRunStoreForTests(): void {
  runs.clear();
  latestRunByDoc.clear();
  rmSync(runStoreFilePath, { force: true });
}

export function createRun(
  spaceId: string,
  documentId: string,
  nodeIds: string[],
  initiatedByUserId: string | null = null,
): string {
  const runId = createId("run");
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
  persistRunStore();
  return runId;
}

export function getRun(runId: string): RunState | undefined {
  return runs.get(runId);
}

export function setRunStatus(runId: string, status: NodeStatus): void {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.status = status;
  persistRunStore();
}

export function setRunAbort(runId: string, abort: () => void): void {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.abort = abort;
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
  persistRunStore();
}

export function appendNodeLog(runId: string, nodeId: string, message: string): void {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const node = run.nodes.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  node.logs.push(message);
  persistRunStore();
}

export function finalizeRun(runId: string): void {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status === "cancelled") return;
  const anyFailed = [...run.nodes.values()].some((n) => n.status === "failed");
  run.status = anyFailed ? "failed" : "completed";
  persistRunStore();
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
  persistRunStore();
}

reloadRunStoreFromDisk();
