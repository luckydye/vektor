import { desc, eq, inArray } from "drizzle-orm";
import { getSpaceDb } from "#db/db.ts";
import { createId } from "#db/ids.ts";
import {
  type WorkflowRunInsert,
  type WorkflowRunRow,
  workflowRun,
} from "#db/schema/space.ts";
import { sendSyncEvent } from "#db/ws.ts";
import { appLogger } from "#observability/logger.ts";
import { realtimeTopics } from "#utils/realtime.ts";
import {
  readWorkflowArtifact,
  writeWorkflowArtifact,
} from "./workflowArtifacts.ts";

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * @deprecated Compatibility shape for workflow runs created before workflows
 * became JavaScript scripts. Do not add new callers or write new data here.
 */
type DeprecatedLegacyNodeState = {
  status?: string;
  outputs?: Record<string, unknown> | null;
  error?: string | null;
  logs?: string[];
};

/**
 * @deprecated Compatibility container for the legacy DAG workflow format.
 * It is only read to lazily move a historical script result into an artifact.
 */
type DeprecatedLegacyNodes = Record<string, DeprecatedLegacyNodeState>;

export type RunState = {
  status: RunStatus;
  spaceId: string;
  documentId: string;
  initiatedByUserId: string | null;
  sourceExtensionId: string | null;
  runtimeInputs: Record<string, unknown>;
  resultArtifactPath: string | null;
  logArtifactPath: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  /** Logs are held only while the workflow is executing, then written as an artifact. */
  logs: string[];
  abort?: () => void;
  /** @deprecated See DeprecatedLegacyNodes. */
  legacyNodes?: DeprecatedLegacyNodes;
};

/**
 * Workflow runs are durable metadata records in per-space SQLite. Results and
 * completed logs are JSON files in artifact storage, referenced by their keys
 * from the row. Memory holds only active runs and their live logs/abort handle.
 */
export const activeRuns = new Map<string, RunState>();

export const RUN_STORE_RECOVERY_ERROR =
  "Workflow process restarted before this run completed";

const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_ENTRIES = 20;
const MAX_LOG_ENTRIES = 200;
const REDACTED_VALUE = "[redacted]";

function isSecretKey(key: string): boolean {
  return /key|token|secret|password|authorization|cookie/i.test(key);
}

function summarizeString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) return value;
  return `${value.slice(0, MAX_STRING_CHARS)}…(truncated ${value.length - MAX_STRING_CHARS} chars)`;
}

function summarizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return summarizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { kind: "buffer", bytes: value.byteLength };
  if (Array.isArray(value)) {
    if (depth >= 2) return { kind: "array", length: value.length };
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

function summarizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return summarizeValue(value) as Record<string, unknown>;
}

function summarizeLogs(messages: string[]): string[] {
  const summarized = messages
    .slice(-MAX_LOG_ENTRIES)
    .map((message) => summarizeString(message));
  const truncatedEntries = messages.length - summarized.length;
  return truncatedEntries > 0
    ? [`…(truncated ${truncatedEntries} log entries)`, ...summarized]
    : summarized;
}

function deserializeDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** @deprecated Read support for old `workflow_run.nodes` snapshots only. */
function parseLegacyNodes(value: string): DeprecatedLegacyNodes | undefined {
  const nodes = parseJsonRecord(value);
  return Object.keys(nodes).length > 0 ? (nodes as DeprecatedLegacyNodes) : undefined;
}

function serializeRunToRow(runId: string, run: RunState): WorkflowRunInsert {
  return {
    id: runId,
    documentId: run.documentId,
    status: run.status,
    initiatedByUserId: run.initiatedByUserId,
    sourceExtensionId: run.sourceExtensionId,
    runtimeInputs: JSON.stringify(summarizeRecord(run.runtimeInputs)),
    resultArtifactPath: run.resultArtifactPath,
    logArtifactPath: run.logArtifactPath,
    error: run.error,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    // @deprecated Keep old DBs writable without storing new workflow results in SQLite.
    nodes: JSON.stringify(run.legacyNodes ?? {}),
    createdAt: run.createdAt,
    updatedAt: new Date(),
  };
}

function deserializeRowToRun(row: WorkflowRunRow, spaceId: string): RunState {
  return {
    status: row.status as RunStatus,
    spaceId,
    documentId: row.documentId,
    initiatedByUserId: row.initiatedByUserId,
    sourceExtensionId: row.sourceExtensionId,
    runtimeInputs: summarizeRecord(parseJsonRecord(row.runtimeInputs)),
    resultArtifactPath: row.resultArtifactPath,
    logArtifactPath: row.logArtifactPath,
    error: row.error ? summarizeString(row.error) : null,
    startedAt: deserializeDate(row.startedAt),
    completedAt: deserializeDate(row.completedAt),
    createdAt: deserializeDate(row.createdAt) ?? new Date(0),
    logs: [],
    // @deprecated Only retained to migrate historical records lazily.
    legacyNodes: parseLegacyNodes(row.nodes),
  };
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

const pendingWrites = new Set<Promise<void>>();
const writeChains = new Map<string, Promise<void>>();

function trackWrite(write: Promise<void>): void {
  pendingWrites.add(write);
  void write.finally(() => pendingWrites.delete(write));
}

function persistNow(runId: string, run: RunState): void {
  // A terminal snapshot must never be overwritten by an earlier asynchronous
  // update (for example, result persistence completing after log persistence).
  const previous = writeChains.get(runId) ?? Promise.resolve();
  const write = previous.then(() => upsertRunToDb(run.spaceId, serializeRunToRow(runId, run)));
  writeChains.set(runId, write);
  const tracked = write.finally(() => {
    if (writeChains.get(runId) === write) writeChains.delete(runId);
  });
  trackWrite(tracked);
}

function emitRunChanged(runId: string, run: RunState): void {
  sendSyncEvent(
    run.spaceId,
    { topic: realtimeTopics.workflowRun(runId) },
    { topic: realtimeTopics.workflowRuns },
  );
}

const recoveredSpaces = new Set<string>();
const recoveryPromises = new Map<string, Promise<void>>();

function applyRecovery(run: RunState, recoveredAt: Date): void {
  run.status = "failed";
  run.error = RUN_STORE_RECOVERY_ERROR;
  run.completedAt = recoveredAt;
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
      if (activeRuns.has(row.id)) continue;
      const run = deserializeRowToRun(row, spaceId);
      applyRecovery(run, recoveredAt);
      await upsertRunToDb(spaceId, serializeRunToRow(row.id, run));
    }
    recoveredSpaces.add(spaceId);
  } catch (error) {
    appLogger.warn("Failed to recover workflow runs", { spaceId, error });
  } finally {
    recoveryPromises.delete(spaceId);
  }
}

/** Repair interrupted script runs for a space once, before serving reads. */
export async function ensureSpaceRecovered(spaceId: string): Promise<void> {
  if (recoveredSpaces.has(spaceId)) return;
  let promise = recoveryPromises.get(spaceId);
  if (!promise) {
    promise = recoverSpace(spaceId);
    recoveryPromises.set(spaceId, promise);
  }
  await promise;
}

export function createRun(
  spaceId: string,
  documentId: string,
  initiatedByUserId: string | null = null,
  sourceExtensionId: string | null = null,
  runtimeInputs: Record<string, unknown> = {},
): string {
  const runId = createId("run");
  const run: RunState = {
    status: "pending",
    spaceId,
    documentId,
    initiatedByUserId,
    sourceExtensionId,
    runtimeInputs: summarizeRecord(runtimeInputs),
    resultArtifactPath: null,
    logArtifactPath: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    logs: [],
  };
  activeRuns.set(runId, run);
  persistNow(runId, run);
  emitRunChanged(runId, run);
  return runId;
}

/** Synchronous read of an active run, used exclusively by the executor. */
export function getRun(runId: string): RunState | undefined {
  return activeRuns.get(runId);
}

export function setRunStatus(runId: string, status: RunStatus): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.status = status;
  if (status === "running" && !run.startedAt) run.startedAt = new Date();
  persistNow(runId, run);
  emitRunChanged(runId, run);
}

export function setRunAbort(runId: string, abort: () => void): void {
  const run = activeRuns.get(runId);
  if (run) run.abort = abort;
}

export function setRunError(runId: string, error: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.error = summarizeString(error);
  persistNow(runId, run);
  emitRunChanged(runId, run);
}

export function appendRunLog(runId: string, message: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.logs.push(summarizeString(message));
  run.logs = summarizeLogs(run.logs);
  emitRunChanged(runId, run);
}

export async function writeRunResult(
  runId: string,
  output: Record<string, unknown>,
): Promise<void> {
  const run = activeRuns.get(runId);
  if (!run) return;
  const artifact = await writeWorkflowArtifact(run.spaceId, runId, "result", output);
  run.resultArtifactPath = artifact.key;
  persistNow(runId, run);
  emitRunChanged(runId, run);
}

export async function writeRunLogs(runId: string): Promise<void> {
  const run = activeRuns.get(runId);
  if (!run || run.logs.length === 0) return;
  const artifact = await writeWorkflowArtifact(run.spaceId, runId, "logs", run.logs);
  run.logArtifactPath = artifact.key;
  persistNow(runId, run);
  emitRunChanged(runId, run);
}

export async function finalizeRun(runId: string): Promise<void> {
  const run = activeRuns.get(runId);
  if (!run) return;
  if (run.status === "pending" || run.status === "running") run.status = "completed";
  run.completedAt ??= new Date();
  persistNow(runId, run);
  emitRunChanged(runId, run);
  await writeChains.get(runId);
  activeRuns.delete(runId);
}

export async function cancelRun(runId: string): Promise<void> {
  const run = activeRuns.get(runId);
  if (!run || (run.status !== "pending" && run.status !== "running")) return;
  run.status = "cancelled";
  run.completedAt = new Date();
  run.abort?.();
  await writeRunLogs(runId);
  persistNow(runId, run);
  emitRunChanged(runId, run);
  await writeChains.get(runId);
  activeRuns.delete(runId);
}

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
  return row ? deserializeRowToRun(row, spaceId) : undefined;
}

export async function listRuns(
  spaceId: string,
  options?: { sourceExtensionId?: string | null; documentId?: string | null },
): Promise<Array<{ runId: string; run: RunState }>> {
  const db = await getSpaceDb(spaceId);
  const rows = await db.select().from(workflowRun).orderBy(desc(workflowRun.createdAt)).all();
  const merged = new Map<string, RunState>();
  for (const row of rows) merged.set(row.id, deserializeRowToRun(row, spaceId));
  for (const [runId, run] of activeRuns) {
    if (run.spaceId === spaceId) merged.set(runId, run);
  }
  let entries = [...merged.entries()];
  if (options?.sourceExtensionId) {
    entries = entries.filter(([, run]) => run.sourceExtensionId === options.sourceExtensionId);
  }
  if (options?.documentId) {
    entries = entries.filter(([, run]) => run.documentId === options.documentId);
  }
  entries.sort(([, a], [, b]) => b.createdAt.getTime() - a.createdAt.getTime());
  return entries.map(([runId, run]) => ({ runId, run }));
}

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

/**
 * @deprecated Transitional migration for rows that stored script outputs in
 * `workflow_run.nodes`. New runs always write their result artifact directly.
 */
export async function migrateLegacyResultArtifact(
  runId: string,
  run: RunState,
): Promise<void> {
  if (run.resultArtifactPath || !run.legacyNodes) return;
  const output = run.legacyNodes._script?.outputs;
  if (!output || typeof output !== "object" || Array.isArray(output)) return;
  const artifact = await writeWorkflowArtifact(run.spaceId, runId, "result", output);
  run.resultArtifactPath = artifact.key;
  await upsertRunToDb(run.spaceId, serializeRunToRow(runId, run));
}

export async function readRunLogs(run: RunState): Promise<string[]> {
  if (run.logs.length > 0) return run.logs;
  if (run.logArtifactPath) {
    const logs = await readWorkflowArtifact<unknown>(run.spaceId, run.logArtifactPath);
    return Array.isArray(logs) ? logs.filter((line): line is string => typeof line === "string") : [];
  }
  // @deprecated Exposes historical node logs as one flat script log.
  return Object.entries(run.legacyNodes ?? {}).flatMap(([nodeId, node]) => [
    ...(node.logs ?? []).map((line) => `[${nodeId}] ${line}`),
    ...(node.error ? [`[${nodeId}] ${node.error}`] : []),
  ]);
}

/** Drain writes so tests can observe the DB deterministically. */
export async function flushRunStoreForTests(): Promise<void> {
  await Promise.all([...pendingWrites]);
}

/** Drop in-memory state, simulating a fresh process (DB rows are untouched). */
export function resetRunStoreMemoryForTests(): void {
  activeRuns.clear();
  recoveredSpaces.clear();
  recoveryPromises.clear();
  writeChains.clear();
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
