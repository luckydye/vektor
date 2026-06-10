import { desc, eq, inArray } from "drizzle-orm";
import { getSpaceDb } from "../db/db.ts";
import { createId } from "../db/ids.ts";
import {
  type WorkflowRunInsert,
  type WorkflowRunRow,
  workflowRun,
} from "../db/schema/space.ts";
import { sendSyncEvent } from "../db/ws.ts";
import { appLogger } from "../observability/logger.ts";
import { realtimeTopics } from "../utils/realtime.ts";

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
  runtimeInputs: Record<string, unknown>;
  createdAt: Date;
  abort?: () => void;
};

type PersistedNodeState = Omit<NodeState, "startedAt" | "completedAt"> & {
  startedAt: string | null;
  completedAt: string | null;
};

/**
 * Workflow runs are durably stored in the per-space SQLite `workflow_run` table —
 * that is the source of truth and the reason run history survives a restart.
 *
 * Memory holds only the *active* runs (status pending/running): the executor mutates
 * their node state synchronously many times per run and each carries a non-serializable
 * `abort` handle. The instant a run reaches a terminal status it is written to the DB
 * and evicted from memory; all history reads go straight to the DB. There is no
 * in-memory history cache and no full hydration on boot — interrupted runs are repaired
 * lazily per space via `ensureSpaceRecovered`.
 */
export const activeRuns = new Map<string, RunState>();

export const RUN_STORE_RECOVERY_ERROR =
  "Workflow process restarted before this run completed";

const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_ENTRIES = 20;
const MAX_LOG_ENTRIES = 200;
const REDACTED_VALUE = "[redacted]";

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
    outputs: node.outputs,
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

// ---------------------------------------------------------------------------
// Serialization to/from the workflow_run row
// ---------------------------------------------------------------------------

function serializeNodes(run: RunState): Record<string, PersistedNodeState> {
  return Object.fromEntries(
    [...run.nodes.entries()].map(([nodeId, node]) => [
      nodeId,
      {
        ...sanitizeNodeState(node),
        startedAt: serializeDate(node.startedAt),
        completedAt: serializeDate(node.completedAt),
      },
    ]),
  );
}

function serializeRunToRow(runId: string, run: RunState): WorkflowRunInsert {
  return {
    id: runId,
    documentId: run.documentId,
    status: run.status,
    initiatedByUserId: run.initiatedByUserId,
    sourceExtensionId: run.sourceExtensionId,
    runtimeInputs: JSON.stringify(summarizeRecord(run.runtimeInputs) ?? {}),
    nodes: JSON.stringify(serializeNodes(run)),
    createdAt: run.createdAt,
    updatedAt: new Date(),
  };
}

function deserializeRowToRun(row: WorkflowRunRow, spaceId: string): RunState {
  const nodesObj = JSON.parse(row.nodes) as Record<string, PersistedNodeState>;
  return normalizeRunState({
    status: row.status as NodeStatus,
    spaceId,
    documentId: row.documentId,
    initiatedByUserId: row.initiatedByUserId,
    sourceExtensionId: row.sourceExtensionId,
    runtimeInputs: JSON.parse(row.runtimeInputs) as Record<string, unknown>,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    nodes: new Map(
      Object.entries(nodesObj).map(([nodeId, node]) => [
        nodeId,
        {
          ...sanitizeNodeState(node as unknown as NodeState),
          startedAt: deserializeDate(node.startedAt),
          completedAt: deserializeDate(node.completedAt),
        },
      ]),
    ),
  });
}

// ---------------------------------------------------------------------------
// Persistence — fire-and-forget upserts of the whole run snapshot
// ---------------------------------------------------------------------------

const pendingWrites = new Set<Promise<void>>();

function trackWrite(write: Promise<void>): void {
  pendingWrites.add(write);
  void write.finally(() => pendingWrites.delete(write));
}

async function upsertRunToDb(spaceId: string, row: WorkflowRunInsert): Promise<void> {
  try {
    const db = await getSpaceDb(spaceId);
    await db
      .insert(workflowRun)
      .values(row)
      .onConflictDoUpdate({ target: workflowRun.id, set: row });
  } catch (error) {
    appLogger.warn("Failed to persist workflow run", { runId: row.id, error });
  }
}

const PERSIST_DEBOUNCE_MS = 500;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const dirtyRuns = new Set<string>();

function flushDirtyRuns(): void {
  const ids = [...dirtyRuns];
  dirtyRuns.clear();
  for (const runId of ids) {
    const run = activeRuns.get(runId);
    // Evicted (already persisted on terminal) — nothing to flush.
    if (!run) continue;
    trackWrite(upsertRunToDb(run.spaceId, serializeRunToRow(runId, run)));
  }
}

/** Debounced persistence for frequent, non-terminal updates (logs, node progress). */
function schedulePersist(runId: string): void {
  dirtyRuns.add(runId);
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushDirtyRuns();
  }, PERSIST_DEBOUNCE_MS);
}

/** Immediate persistence for important/structural changes (create, status, terminal). */
function persistNow(runId: string, run: RunState): void {
  dirtyRuns.delete(runId);
  trackWrite(upsertRunToDb(run.spaceId, serializeRunToRow(runId, run)));
}

// ---------------------------------------------------------------------------
// Realtime — broadcast a lightweight signal; clients re-fetch via the API
// ---------------------------------------------------------------------------

function emitRunChanged(runId: string, run: RunState): void {
  sendSyncEvent(
    run.spaceId,
    { topic: realtimeTopics.workflowRun(runId) },
    { topic: realtimeTopics.workflowRuns },
  );
}

// ---------------------------------------------------------------------------
// Recovery — repair runs left mid-flight by a previous process, per space
// ---------------------------------------------------------------------------

const recoveredSpaces = new Set<string>();
const recoveryPromises = new Map<string, Promise<void>>();

function applyRecovery(run: RunState, recoveredAt: Date): void {
  for (const node of run.nodes.values()) {
    if (node.status === "running") {
      node.status = "failed";
      node.error = RUN_STORE_RECOVERY_ERROR;
      node.completedAt = node.completedAt ?? recoveredAt;
    } else if (node.status === "pending") {
      node.status = "cancelled";
      node.completedAt = node.completedAt ?? recoveredAt;
    }
  }
  run.status = "failed";
}

async function recoverSpace(spaceId: string): Promise<void> {
  try {
    const db = await getSpaceDb(spaceId);
    const rows = await db
      .select()
      .from(workflowRun)
      .where(inArray(workflowRun.status, ["pending", "running"]))
      .all();
    const recoveredAt = new Date();
    for (const row of rows) {
      // A row still active in *this* process is genuinely running — leave it.
      if (activeRuns.has(row.id)) continue;
      const run = deserializeRowToRun(row, spaceId);
      applyRecovery(run, recoveredAt);
      await upsertRunToDb(spaceId, serializeRunToRow(row.id, run));
    }
    recoveredSpaces.add(spaceId);
  } catch (error) {
    appLogger.warn("Failed to recover workflow runs", { spaceId, error });
    // Leave the space unmarked so a later access retries recovery.
  } finally {
    recoveryPromises.delete(spaceId);
  }
}

/** Repair interrupted runs for a space once, before serving reads. */
export async function ensureSpaceRecovered(spaceId: string): Promise<void> {
  if (recoveredSpaces.has(spaceId)) return;
  let promise = recoveryPromises.get(spaceId);
  if (!promise) {
    promise = recoverSpace(spaceId);
    recoveryPromises.set(spaceId, promise);
  }
  await promise;
}

// ---------------------------------------------------------------------------
// Mutations (synchronous, operate on the active in-memory run)
// ---------------------------------------------------------------------------

export function createRun(
  spaceId: string,
  documentId: string,
  nodeIds: string[] = [],
  initiatedByUserId: string | null = null,
  sourceExtensionId: string | null = null,
  runtimeInputs: Record<string, unknown> = {},
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
  const run: RunState = {
    status: "pending",
    nodes,
    spaceId,
    documentId,
    initiatedByUserId,
    sourceExtensionId,
    runtimeInputs,
    createdAt,
  };
  activeRuns.set(runId, run);
  persistNow(runId, run);
  emitRunChanged(runId, run);
  return runId;
}

/** Synchronous read of an *active* run (used by the executor). */
export function getRun(runId: string): RunState | undefined {
  return activeRuns.get(runId);
}

export function setRunStatus(runId: string, status: NodeStatus): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.status = status;
  persistNow(runId, run);
  emitRunChanged(runId, run);
}

export function setRunAbort(runId: string, abort: () => void): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.abort = abort;
}

export function addNode(runId: string, nodeId: string): void {
  const run = activeRuns.get(runId);
  if (!run || run.nodes.has(nodeId)) return;
  run.nodes.set(nodeId, {
    status: "pending",
    inputs: {},
    outputs: null,
    error: null,
    logs: [],
    startedAt: null,
    completedAt: null,
  });
  schedulePersist(runId);
}

export function setNodeStatus(
  runId: string,
  nodeId: string,
  update: Partial<NodeState>,
): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  const node = run.nodes.get(nodeId);
  if (!node) return;
  const sanitizedUpdate: Partial<NodeState> = { ...update };
  if (sanitizedUpdate.inputs) {
    sanitizedUpdate.inputs = summarizeRecord(sanitizedUpdate.inputs) ?? {};
  }
  // outputs are structured data — do not truncate (used for retry preSeeded)
  if (sanitizedUpdate.error) {
    sanitizedUpdate.error = summarizeString(sanitizedUpdate.error);
  }
  Object.assign(node, sanitizedUpdate);
  const isTerminalNode =
    sanitizedUpdate.status &&
    sanitizedUpdate.status !== "pending" &&
    sanitizedUpdate.status !== "running";
  if (isTerminalNode) {
    // Persist a completed node's outputs promptly so a crash can't lose them.
    persistNow(runId, run);
  } else {
    schedulePersist(runId);
  }
  emitRunChanged(runId, run);
}

export function appendNodeLog(runId: string, nodeId: string, message: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  const node = run.nodes.get(nodeId);
  if (!node) return;
  node.logs.push(summarizeString(message));
  if (node.logs.length > MAX_LOG_ENTRIES) {
    node.logs = summarizeLogs(node.logs);
  }
  schedulePersist(runId);
  emitRunChanged(runId, run);
}

export function finalizeRun(runId: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  if (run.status !== "cancelled") {
    const anyFailed = [...run.nodes.values()].some((n) => n.status === "failed");
    run.status = anyFailed ? "failed" : "completed";
  }
  persistNow(runId, run);
  emitRunChanged(runId, run);
  activeRuns.delete(runId);
}

export function cancelRun(runId: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.status = "cancelled";
  run.abort?.();
  for (const node of run.nodes.values()) {
    if (node.status === "pending" || node.status === "running") {
      node.status = "cancelled";
      node.completedAt = new Date();
    }
  }
  persistNow(runId, run);
  emitRunChanged(runId, run);
  activeRuns.delete(runId);
}

// ---------------------------------------------------------------------------
// Reads (async, DB is the source of truth; overlay live active runs)
// ---------------------------------------------------------------------------

/** Read a run by id — the live active copy if present, otherwise from the DB. */
export async function getRunForRead(
  spaceId: string,
  runId: string,
): Promise<RunState | undefined> {
  const active = activeRuns.get(runId);
  if (active && active.spaceId === spaceId) return active;
  const db = await getSpaceDb(spaceId);
  const rows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, runId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) return undefined;
  return deserializeRowToRun(row, spaceId);
}

/** All runs in a space, newest first. Live active runs override their DB snapshot. */
export async function listRuns(
  spaceId: string,
  options?: { sourceExtensionId?: string | null; documentId?: string | null },
): Promise<Array<{ runId: string; run: RunState }>> {
  const db = await getSpaceDb(spaceId);
  const rows = await db
    .select()
    .from(workflowRun)
    .orderBy(desc(workflowRun.createdAt))
    .all();
  const merged = new Map<string, RunState>();
  for (const row of rows) {
    merged.set(row.id, deserializeRowToRun(row, spaceId));
  }
  for (const [runId, run] of activeRuns) {
    if (run.spaceId === spaceId) merged.set(runId, run);
  }
  let entries = [...merged.entries()];
  if (options?.sourceExtensionId) {
    entries = entries.filter(
      ([, run]) => run.sourceExtensionId === options.sourceExtensionId,
    );
  }
  if (options?.documentId) {
    entries = entries.filter(([, run]) => run.documentId === options.documentId);
  }
  entries.sort(([, a], [, b]) => b.createdAt.getTime() - a.createdAt.getTime());
  return entries.map(([runId, run]) => ({ runId, run }));
}

/** Id of the most recent run for a document (active copy wins on a tie). */
export async function getLatestRunIdForDoc(
  spaceId: string,
  documentId: string,
): Promise<string | undefined> {
  let latestActive: { runId: string; createdAt: Date } | undefined;
  for (const [runId, run] of activeRuns) {
    if (run.spaceId !== spaceId || run.documentId !== documentId) continue;
    if (!latestActive || run.createdAt > latestActive.createdAt) {
      latestActive = { runId, createdAt: run.createdAt };
    }
  }
  const db = await getSpaceDb(spaceId);
  const rows = await db
    .select({ id: workflowRun.id, createdAt: workflowRun.createdAt })
    .from(workflowRun)
    .where(eq(workflowRun.documentId, documentId))
    .orderBy(desc(workflowRun.createdAt))
    .limit(1)
    .all();
  const dbLatest = rows[0];
  if (latestActive && (!dbLatest || latestActive.createdAt >= dbLatest.createdAt)) {
    return latestActive.runId;
  }
  return dbLatest?.id;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Drain debounced + in-flight writes so tests can observe the DB deterministically. */
export async function flushRunStoreForTests(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    flushDirtyRuns();
  }
  await Promise.all([...pendingWrites]);
}

/** Drop all in-memory state, simulating a fresh process (DB rows are untouched). */
export function resetRunStoreMemoryForTests(): void {
  activeRuns.clear();
  recoveredSpaces.clear();
  recoveryPromises.clear();
  dirtyRuns.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

/** Reset memory and delete all persisted runs for a space. */
export async function clearRunStoreForTests(spaceId: string): Promise<void> {
  await flushRunStoreForTests();
  resetRunStoreMemoryForTests();
  try {
    const db = await getSpaceDb(spaceId);
    await db.delete(workflowRun);
  } catch (error) {
    appLogger.warn("Failed to clear workflow runs for tests", { spaceId, error });
  }
}
