import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret } from "#db/secretsCrypto.ts";
import { appLogger } from "#observability/logger.ts";
import {
  readWorkflowArtifact,
  workflowArtifactKey,
  writeWorkflowArtifact,
} from "./workflowArtifacts.ts";

/**
 * Content-addressed memoization for workflow `runJob` calls.
 *
 * A workflow is an imperative script that re-runs from the top every time. To
 * support resume-from-failure we key each `runJob` result by
 * (extensionId, jobId, inputs) so a subsequent run seeded with a prior run's
 * cache can replay already-completed steps instantly instead of re-executing
 * expensive work (e.g. hundreds of model calls).
 *
 * The key is a hash of the canonical, key-sorted JSON of the inputs, so the
 * same logical call produces the same key regardless of object key ordering.
 * Identical calls (same job + same inputs) therefore collapse to one entry —
 * on resume they replay the same result. A job that must re-run for its side
 * effects on every attempt should vary its inputs.
 */
export type WorkflowStepCache = Record<string, Record<string, unknown>>;

/**
 * Everything a retry needs to reproduce a run: the *exact* runtime inputs plus
 * the step cache.
 *
 * The inputs are kept here rather than read back from the run document because
 * the document copy is display metadata — it goes into a `property` row that is
 * rewritten on every state transition, feeds the space search index, and is
 * returned to any space viewer, so it is summarized: secret-named keys become
 * "[redacted]", long strings are truncated and large arrays collapse to a
 * descriptor object. Resuming from that copy would run the workflow with
 * corrupted inputs and could complete "successfully" with wrong output.
 *
 * This artifact is encrypted at rest: unlike the result and log artifacts it
 * holds raw trigger inputs and raw intermediate step outputs, which may contain
 * credentials, and workflow artifacts are served to any space viewer.
 */
export type WorkflowResumeState = {
  inputs: Record<string, unknown>;
  steps: WorkflowStepCache;
};

/** Skip caching a single step output larger than this; it re-runs on retry. */
const MAX_STEP_BYTES = 256 * 1024;
/** Stop caching once the accumulated step outputs reach this size. */
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  );
  return `{${entries.join(",")}}`;
}

export function stepCacheKey(
  extensionId: string,
  jobId: string,
  inputs: Record<string, unknown>,
): string {
  // JSON array framing keeps the three parts unambiguous (internal quotes are
  // escaped) without embedding delimiter bytes in the source.
  const canonical = JSON.stringify([extensionId, jobId, stableStringify(inputs)]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Narrow an untrusted artifact payload back into a step cache map. */
export function coerceStepCache(value: unknown): WorkflowStepCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: WorkflowStepCache = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      out[key] = entry as Record<string, unknown>;
    }
  }
  return out;
}

export type StepCacheWriter = {
  /** Cache a successful step output, unless it would exceed the size budget. */
  record(key: string, value: Record<string, unknown>): void;
  snapshot(): WorkflowStepCache;
  /** How many step outputs were left out because of the size budget. */
  droppedSteps(): number;
};

/**
 * Accumulates the step cache a run will persist, under a byte budget.
 *
 * Every other persisted run field is bounded (2 KB strings, 200 log entries),
 * but step outputs are raw job results, held in memory for the whole run and
 * written as one JSON artifact on every attempt — and a resumed run carries the
 * prior run's entries forward, so without a cap a long workflow grows without
 * bound across retries. Dropping an entry only costs re-execution, never
 * correctness, so the budget is enforced by simply not caching.
 */
export function createStepCacheWriter(seed: WorkflowStepCache = {}): StepCacheWriter {
  const steps = new Map<string, Record<string, unknown>>();
  let bytes = 0;
  let dropped = 0;

  const writer: StepCacheWriter = {
    record(key, value) {
      if (steps.has(key)) return;
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
      } catch {
        dropped++;
        return;
      }
      if (size > MAX_STEP_BYTES || bytes + size > MAX_CACHE_BYTES) {
        dropped++;
        return;
      }
      steps.set(key, value);
      bytes += size;
    },
    snapshot() {
      return Object.fromEntries(steps);
    },
    droppedSteps() {
      return dropped;
    },
  };

  // Carry the seed forward so a chain of retries keeps resuming — subject to the
  // same budget, which also re-bounds a cache written before these caps existed.
  for (const [key, value] of Object.entries(seed)) writer.record(key, value);
  return writer;
}

type EncryptedArtifact = {
  v: 1;
  ciphertext: string;
  iv: string;
  authTag: string;
};

function isEncryptedArtifact(value: unknown): value is EncryptedArtifact {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.ciphertext === "string" &&
    typeof record.iv === "string" &&
    typeof record.authTag === "string"
  );
}

/** Encrypt a resume state for storage. Exported for tests. */
export function sealResumeState(state: WorkflowResumeState): EncryptedArtifact {
  return { v: 1, ...encryptSecret(JSON.stringify(state)) };
}

/** Decrypt a stored resume state, or null if it is missing or unreadable. */
export function openResumeState(value: unknown): WorkflowResumeState | null {
  if (!isEncryptedArtifact(value)) return null;
  try {
    const parsed: unknown = JSON.parse(decryptSecret(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const inputs =
      record.inputs && typeof record.inputs === "object" && !Array.isArray(record.inputs)
        ? (record.inputs as Record<string, unknown>)
        : {};
    return { inputs, steps: coerceStepCache(record.steps) };
  } catch {
    return null;
  }
}

/**
 * Persist a run's resume state.
 *
 * Keyed only by (spaceId, runId) — the artifact path is derived, not stored on
 * the run — so this works even after the run has been evicted from the active
 * map, which is what happens when a run is cancelled.
 */
export async function writeRunResumeState(
  spaceId: string,
  runId: string,
  state: WorkflowResumeState,
): Promise<void> {
  try {
    await writeWorkflowArtifact(spaceId, runId, "resume", sealResumeState(state));
  } catch (error) {
    // Losing the resume state costs a full re-run on retry, never correctness.
    appLogger.warn("Failed to persist workflow resume state", { runId, error });
  }
}

/** Load a run's resume state, or null if it has none. */
export async function readRunResumeState(
  spaceId: string,
  runId: string,
): Promise<WorkflowResumeState | null> {
  const value = await readWorkflowArtifact<unknown>(
    spaceId,
    workflowArtifactKey(runId, "resume"),
  );
  return openResumeState(value);
}
