import { and, desc, eq } from "drizzle-orm";
import { getSpaceDb } from "#db/db.ts";
import {
  assertDocumentCanParent,
  type DocumentWithProperties,
  getDocument,
} from "#db/documents.ts";
import { createId } from "#db/ids.ts";
import { document, property } from "#db/schema/space.ts";
import { sendSyncEvent } from "#db/ws.ts";
import { appLogger } from "#observability/logger.ts";
import { workflowRunDocumentType } from "#utils/documentTypes.ts";
import { realtimeTopics } from "#utils/realtime.ts";
import { readWorkflowArtifact, writeWorkflowArtifact } from "./workflowArtifacts.ts";

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type RunState = {
  status: RunStatus;
  spaceId: string;
  /** Parent workflow document id. */
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
};

/**
 * Active executions only. Persisted workflow runs are hidden, readonly child
 * documents of their workflow document, not rows in a dedicated run table.
 */
export const activeRuns = new Map<string, RunState>();

export const RUN_STORE_RECOVERY_ERROR =
  "Workflow process restarted before this run completed";

const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_ENTRIES = 20;
const MAX_LOG_ENTRIES = 200;
const REDACTED_VALUE = "[redacted]";

const runProperty = {
  status: "_workflowRunStatus",
  initiatedByUserId: "_workflowRunInitiatedByUserId",
  sourceExtensionId: "_workflowRunSourceExtensionId",
  runtimeInputs: "_workflowRunRuntimeInputs",
  resultArtifactPath: "_workflowRunResultArtifactPath",
  logArtifactPath: "_workflowRunLogArtifactPath",
  error: "_workflowRunError",
  startedAt: "_workflowRunStartedAt",
  completedAt: "_workflowRunCompletedAt",
} as const;

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

function parseInputs(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? summarizeRecord(parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function propertyValue(
  properties: DocumentWithProperties["properties"],
  key: string,
): string | undefined {
  const value = properties[key];
  return Array.isArray(value) ? value[0] : value;
}

function nullableProperty(value: string | null): string {
  return value ?? "";
}

function deserializeRun(
  runId: string,
  doc: DocumentWithProperties,
): RunState | undefined {
  if (doc.type !== workflowRunDocumentType || !doc.parentId) return undefined;
  const properties = doc.properties;
  const status = propertyValue(properties, runProperty.status) as RunStatus | undefined;
  if (!status) return undefined;

  return {
    status,
    spaceId: "",
    documentId: doc.parentId,
    initiatedByUserId: propertyValue(properties, runProperty.initiatedByUserId) || null,
    sourceExtensionId: propertyValue(properties, runProperty.sourceExtensionId) || null,
    runtimeInputs: parseInputs(propertyValue(properties, runProperty.runtimeInputs)),
    resultArtifactPath: propertyValue(properties, runProperty.resultArtifactPath) || null,
    logArtifactPath: propertyValue(properties, runProperty.logArtifactPath) || null,
    error: propertyValue(properties, runProperty.error) || null,
    startedAt: parseDate(propertyValue(properties, runProperty.startedAt)),
    completedAt: parseDate(propertyValue(properties, runProperty.completedAt)),
    createdAt: doc.createdAt,
    logs: [],
  };
}

function runProperties(
  run: RunState,
): Array<{ key: string; value: string; type: string }> {
  return [
    { key: runProperty.status, value: run.status, type: "workflow-run-status" },
    {
      key: runProperty.initiatedByUserId,
      value: nullableProperty(run.initiatedByUserId),
      type: "user-id",
    },
    {
      key: runProperty.sourceExtensionId,
      value: nullableProperty(run.sourceExtensionId),
      type: "extension-id",
    },
    {
      key: runProperty.runtimeInputs,
      value: JSON.stringify(summarizeRecord(run.runtimeInputs)),
      type: "json",
    },
    {
      key: runProperty.resultArtifactPath,
      value: nullableProperty(run.resultArtifactPath),
      type: "artifact-key",
    },
    {
      key: runProperty.logArtifactPath,
      value: nullableProperty(run.logArtifactPath),
      type: "artifact-key",
    },
    { key: runProperty.error, value: nullableProperty(run.error), type: "text" },
    {
      key: runProperty.startedAt,
      value: run.startedAt?.toISOString() ?? "",
      type: "datetime",
    },
    {
      key: runProperty.completedAt,
      value: run.completedAt?.toISOString() ?? "",
      type: "datetime",
    },
  ];
}

async function persistRunToDocument(runId: string, run: RunState): Promise<void> {
  try {
    const db = await getSpaceDb(run.spaceId);
    const now = new Date();
    await db
      .update(document)
      .set({ updatedAt: now })
      .where(and(eq(document.id, runId), eq(document.type, workflowRunDocumentType)));

    for (const entry of runProperties(run)) {
      await db
        .insert(property)
        .values({
          id: createId("property"),
          documentId: runId,
          key: entry.key,
          value: entry.value,
          type: entry.type,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [property.documentId, property.key],
          set: { value: entry.value, type: entry.type, updatedAt: now },
        });
    }
  } catch (error) {
    appLogger.warn("Failed to persist workflow run document", { runId, error });
  }
}

const pendingWrites = new Set<Promise<void>>();
const writeChains = new Map<string, Promise<void>>();

function trackWrite(write: Promise<void>): void {
  pendingWrites.add(write);
  void write.finally(() => pendingWrites.delete(write));
}

function persistNow(runId: string, run: RunState): void {
  const previous = writeChains.get(runId) ?? Promise.resolve();
  const write = previous.then(() => persistRunToDocument(runId, run));
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

async function listStoredRuns(
  spaceId: string,
  documentId?: string | null,
): Promise<Array<{ runId: string; run: RunState }>> {
  const db = await getSpaceDb(spaceId);
  const conditions = [eq(document.type, workflowRunDocumentType)];
  if (documentId) conditions.push(eq(document.parentId, documentId));
  const rows = await db
    .select({ id: document.id })
    .from(document)
    .where(and(...conditions))
    .orderBy(desc(document.createdAt))
    .all();
  const runs = await Promise.all(
    rows.map(async ({ id }) => {
      const doc = await getDocument(spaceId, id);
      const run = doc ? deserializeRun(id, doc) : undefined;
      return run ? { runId: id, run: { ...run, spaceId } } : undefined;
    }),
  );
  return runs.filter((entry): entry is { runId: string; run: RunState } =>
    Boolean(entry),
  );
}

function applyRecovery(run: RunState, recoveredAt: Date): void {
  run.status = "failed";
  run.error = RUN_STORE_RECOVERY_ERROR;
  run.completedAt = recoveredAt;
}

async function recoverSpace(spaceId: string): Promise<void> {
  try {
    const runs = await listStoredRuns(spaceId);
    const recoveredAt = new Date();
    for (const { runId, run } of runs) {
      if (
        activeRuns.has(runId) ||
        (run.status !== "pending" && run.status !== "running")
      ) {
        continue;
      }
      applyRecovery(run, recoveredAt);
      await persistRunToDocument(runId, run);
    }
    recoveredSpaces.add(spaceId);
  } catch (error) {
    appLogger.warn("Failed to recover workflow run documents", { spaceId, error });
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

export async function createRun(
  spaceId: string,
  documentId: string,
  createdBy: string,
  initiatedByUserId: string | null = null,
  sourceExtensionId: string | null = null,
  runtimeInputs: Record<string, unknown> = {},
): Promise<string> {
  const runId = createId("document");
  const now = new Date();
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
    createdAt: now,
    logs: [],
  };
  const db = await getSpaceDb(spaceId);
  await assertDocumentCanParent(spaceId, documentId, workflowRunDocumentType);
  await db.insert(document).values({
    id: runId,
    slug: `workflow-run-${runId.slice("doc_".length)}`,
    type: workflowRunDocumentType,
    archived: true,
    readonly: true,
    content: "",
    currentRev: 0,
    publishedRev: null,
    parentId: documentId,
    createdAt: now,
    updatedAt: now,
    createdBy,
  });
  activeRuns.set(runId, run);
  persistNow(runId, run);
  await writeChains.get(runId);
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
  const doc = await getDocument(spaceId, runId);
  const run = doc ? deserializeRun(runId, doc) : undefined;
  return run ? { ...run, spaceId } : undefined;
}

export async function listRuns(
  spaceId: string,
  options?: { sourceExtensionId?: string | null; documentId?: string | null },
): Promise<Array<{ runId: string; run: RunState }>> {
  const merged = new Map<string, RunState>();
  for (const { runId, run } of await listStoredRuns(spaceId, options?.documentId)) {
    merged.set(runId, run);
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

export async function getLatestRunIdForDoc(
  spaceId: string,
  documentId: string,
): Promise<string | undefined> {
  const runs = await listRuns(spaceId, { documentId });
  return runs[0]?.runId;
}

export async function readRunLogs(run: RunState): Promise<string[]> {
  if (run.logs.length > 0) return run.logs;
  if (run.logArtifactPath) {
    const logs = await readWorkflowArtifact<unknown>(run.spaceId, run.logArtifactPath);
    return Array.isArray(logs)
      ? logs.filter((line): line is string => typeof line === "string")
      : [];
  }
  return [];
}

/** Drain writes so tests can observe the document store deterministically. */
export async function flushRunStoreForTests(): Promise<void> {
  await Promise.all([...pendingWrites]);
}

/** Drop in-memory state, simulating a fresh process (documents are untouched). */
export function resetRunStoreMemoryForTests(): void {
  activeRuns.clear();
  recoveredSpaces.clear();
  recoveryPromises.clear();
  writeChains.clear();
}

/** Reset memory and delete all hidden workflow-run documents for a space. */
export async function clearRunStoreForTests(spaceId: string): Promise<void> {
  await flushRunStoreForTests();
  resetRunStoreMemoryForTests();
  try {
    const db = await getSpaceDb(spaceId);
    await db.delete(document).where(eq(document.type, workflowRunDocumentType));
  } catch (error) {
    appLogger.warn("Failed to clear workflow run documents for tests", {
      spaceId,
      error,
    });
  }
}
