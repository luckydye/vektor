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
  sourceExtensionId: string | null;
  createdAt: Date;
  abort?: () => void;
};

type PersistedNodeState = Omit<NodeState, "startedAt" | "completedAt"> & {
  startedAt: string | null;
  completedAt: string | null;
};

type PersistedRunState = Omit<RunState, "nodes" | "abort" | "createdAt"> & {
  createdAt: string | null;
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

const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_ENTRIES = 20;
const MAX_LOG_ENTRIES = 200;
const MAX_RUNS = 20;
const REDACTED_VALUE = "[redacted]";

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

function isSecretKey(key: string): boolean {
  return /key|token|secret|password|authorization|cookie/i.test(key);
}

function summarizeString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_STRING_CHARS)}…(truncated ${value.length - MAX_STRING_CHARS} chars)`;
}

function summarizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return summarizeString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return {
      kind: "buffer",
      bytes: value.byteLength,
    };
  }
  if (Array.isArray(value)) {
    if (depth >= 2) {
      return {
        kind: "array",
        length: value.length,
      };
    }
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => summarizeValue(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS
      ? {
          kind: "array",
          length: value.length,
          items,
          truncatedItems: value.length - MAX_ARRAY_ITEMS,
        }
      : items;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (depth >= 2) {
      return {
        kind: "object",
        keys: Object.keys(record).slice(0, MAX_OBJECT_ENTRIES),
        truncatedKeys: Math.max(0, Object.keys(record).length - MAX_OBJECT_ENTRIES),
      };
    }

    const entries = Object.entries(record);
    const summary: Record<string, unknown> = {};
    for (const [index, [key, entryValue]] of entries.entries()) {
      if (index >= MAX_OBJECT_ENTRIES) {
        summary.__truncatedKeys = entries.length - MAX_OBJECT_ENTRIES;
        break;
      }
      summary[key] = isSecretKey(key)
        ? REDACTED_VALUE
        : summarizeValue(entryValue, depth + 1);
    }
    return summary;
  }
  return String(value);
}

function summarizeRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  return summarizeValue(value) as Record<string, unknown>;
}

function summarizeLogs(messages: string[]): string[] {
  const summarized = messages
    .slice(-MAX_LOG_ENTRIES)
    .map((message) => summarizeString(message));
  const truncatedEntries = messages.length - summarized.length;
  if (truncatedEntries <= 0) {
    return summarized;
  }
  return [`…(truncated ${truncatedEntries} log entries)`, ...summarized];
}

function sanitizeNodeState(node: NodeState): NodeState {
  return {
    ...node,
    inputs: summarizeRecord(node.inputs) ?? {},
    outputs: summarizeRecord(node.outputs),
    logs: summarizeLogs(node.logs),
    error: node.error ? summarizeString(node.error) : null,
  };
}

function normalizeRunState(run: RunState): RunState {
  const fallbackCreatedAt =
    [...run.nodes.values()]
      .map((node) => node.startedAt ?? node.completedAt)
      .find((value): value is Date => value instanceof Date) ?? new Date(0);

  run.createdAt =
    run.createdAt instanceof Date && !Number.isNaN(run.createdAt.getTime())
      ? run.createdAt
      : fallbackCreatedAt;

  run.nodes = new Map(
    [...run.nodes.entries()].map(([nodeId, node]) => [nodeId, sanitizeNodeState(node)]),
  );

  return run;
}

function pruneCompletedRuns(): void {
  const retainedRunIds = new Set(
    [...runs.entries()]
      .filter(([, run]) => run.status === "pending" || run.status === "running")
      .map(([runId]) => runId),
  );
  const completedRuns = [...runs.entries()]
    .filter(([, run]) => run.status !== "pending" && run.status !== "running")
    .sort(([, a], [, b]) => b.createdAt.getTime() - a.createdAt.getTime());

  for (const [runId] of completedRuns.slice(0, MAX_RUNS)) {
    retainedRunIds.add(runId);
  }

  for (const [runId] of runs) {
    if (!retainedRunIds.has(runId)) {
      runs.delete(runId);
    }
  }

  for (const [documentId, runId] of latestRunByDoc) {
    if (!runs.has(runId)) {
      latestRunByDoc.delete(documentId);
    }
  }
}

function serializeRun(run: RunState): PersistedRunState {
  return {
    status: run.status,
    spaceId: run.spaceId,
    documentId: run.documentId,
    initiatedByUserId: run.initiatedByUserId,
    sourceExtensionId: run.sourceExtensionId,
    createdAt: serializeDate(run.createdAt),
    nodes: Object.fromEntries(
      [...run.nodes.entries()].map(([nodeId, node]) => [
        nodeId,
        {
          ...sanitizeNodeState(node),
          startedAt: serializeDate(node.startedAt),
          completedAt: serializeDate(node.completedAt),
        },
      ]),
    ),
  };
}

function deserializeRun(serialized: PersistedRunState): RunState {
  return normalizeRunState({
    status: serialized.status,
    spaceId: serialized.spaceId,
    documentId: serialized.documentId,
    initiatedByUserId: serialized.initiatedByUserId,
    sourceExtensionId: serialized.sourceExtensionId ?? null,
    createdAt: deserializeDate(serialized.createdAt) ?? new Date(0),
    nodes: new Map(
      Object.entries(serialized.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          ...sanitizeNodeState(node),
          startedAt: deserializeDate(node.startedAt),
          completedAt: deserializeDate(node.completedAt),
        },
      ]),
    ),
  });
}

function persistRunStore(): void {
  pruneCompletedRuns();
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
    runs.set(runId, normalizeRunState(deserializeRun(run)));
  }
  for (const [documentId, runId] of Object.entries(serialized.latestRunByDoc)) {
    latestRunByDoc.set(documentId, runId);
  }
  recoverInterruptedRuns();
  persistRunStore();
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
  sourceExtensionId: string | null = null,
): string {
  const runId = createId("run");
  const createdAt = new Date();
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
  runs.set(runId, {
    status: "pending",
    nodes,
    spaceId,
    documentId,
    initiatedByUserId,
    sourceExtensionId,
    createdAt,
  });
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
  const sanitizedUpdate: Partial<NodeState> = { ...update };
  if (sanitizedUpdate.inputs) {
    sanitizedUpdate.inputs = summarizeRecord(sanitizedUpdate.inputs) ?? {};
  }
  if (sanitizedUpdate.outputs) {
    sanitizedUpdate.outputs = summarizeRecord(sanitizedUpdate.outputs);
  }
  if (sanitizedUpdate.error) {
    sanitizedUpdate.error = summarizeString(sanitizedUpdate.error);
  }
  Object.assign(node, sanitizedUpdate);
  persistRunStore();
}

export function appendNodeLog(runId: string, nodeId: string, message: string): void {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const node = run.nodes.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  node.logs.push(summarizeString(message));
  if (node.logs.length > MAX_LOG_ENTRIES) {
    node.logs = summarizeLogs(node.logs);
  }
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
