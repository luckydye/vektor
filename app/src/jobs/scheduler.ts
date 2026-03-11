import { Worker } from "node:worker_threads";
import { mkdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { extractFile } from "../db/extensions.ts";
import { config } from "../config.ts";
import { createJobToken } from "./jobToken.ts";
import { buildJobWrapper } from "./jobRuntime.ts";
import { activeTraceHeaders, otelMetrics, withSpan } from "../observability/otel.ts";

/**
 * Extract a job entry file from a zip Buffer, run it as a worker thread,
 * await the parentPort response, clean up temp files, and return outputs.
 *
 * The job runs inside a generated wrapper that installs the wiki runtime
 * globals (uploadArtifact, etc.) before importing the actual job file.
 *
 * workerData passed to the job: { ...inputs, spaceId, apiUrl, jobToken }
 *
 * The job worker posts:
 *   { success: true, outputs: { ... } }  on success
 *   { success: false, error: "..." }      on failure
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONCURRENT_JOBS = 3;

let activeJobs = 0;
const waitQueue: Array<() => void> = [];
const meter = otelMetrics.getMeter("wiki.jobs");
const jobsStartedCounter = meter.createCounter("wiki_jobs_started_total");
const jobsCompletedCounter = meter.createCounter("wiki_jobs_completed_total");
const jobsFailedCounter = meter.createCounter("wiki_jobs_failed_total");
const jobDurationMs = meter.createHistogram("wiki_job_duration_ms", {
  unit: "ms",
});
const jobQueueWaitMs = meter.createHistogram("wiki_job_queue_wait_ms", {
  unit: "ms",
});
const activeJobsGauge = meter.createUpDownCounter("wiki_jobs_active");
const queuedJobsGauge = meter.createUpDownCounter("wiki_jobs_queued");
const MAX_SPAN_JSON_CHARS = 4_000;

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Unsupported cache number: ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported cache value type: ${typeof value}`);
}

async function getCacheFilePath(scope: string, key: string): Promise<string> {
  const dir = join(tmpdir(), "wiki-job-cache", scope);
  await mkdir(dir, { recursive: true });
  return join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
}

export async function clearJobCache(scope: string): Promise<void> {
  await rm(join(tmpdir(), "wiki-job-cache", scope), { recursive: true, force: true });
}

async function readCachedOutputs(
  scope: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  const file = await getCacheFilePath(scope, key);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as {
    expiresAt: number | null;
    value: Record<string, unknown>;
  };
  if (parsed.expiresAt !== null && Date.now() >= parsed.expiresAt) {
    await rm(file, { force: true });
    return null;
  }
  return parsed.value;
}

async function writeCachedOutputs(
  scope: string,
  key: string,
  value: Record<string, unknown>,
  ttlMs?: number,
): Promise<void> {
  const file = await getCacheFilePath(scope, key);
  const expiresAt = typeof ttlMs === "number" && ttlMs > 0 ? Date.now() + ttlMs : null;
  await writeFile(file, JSON.stringify({ expiresAt, value }), "utf-8");
}

function toSpanJson(value: unknown, maxChars = MAX_SPAN_JSON_CHARS): string {
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "null";
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(0, maxChars)}…(truncated ${raw.length - maxChars} chars)`;
  } catch (error) {
    return JSON.stringify({
      error: "serialization_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function releaseJobSlot(): void {
  activeJobs = Math.max(0, activeJobs - 1);
  activeJobsGauge.add(-1);
  const next = waitQueue.shift();
  if (next) {
    queuedJobsGauge.add(-1);
    activeJobs += 1;
    activeJobsGauge.add(1);
    next();
  }
}

function acquireJobSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Job cancelled"));

  if (activeJobs < MAX_CONCURRENT_JOBS) {
    activeJobs += 1;
    activeJobsGauge.add(1);
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    const onAbort = () => {
      const idx = waitQueue.indexOf(start);
      if (idx >= 0) {
        waitQueue.splice(idx, 1);
        queuedJobsGauge.add(-1);
      }
      reject(new Error("Job cancelled"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    waitQueue.push(start);
    queuedJobsGauge.add(1);
  });
}

export async function runJob(
  zipBuffer: Buffer,
  entryPath: string,
  inputs: Record<string, unknown>,
  spaceId: string,
  onLog?: (message: string) => void,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    cacheScopeId?: string;
    cacheTtlMs?: number;
    initiatedByUserId?: string | null;
    jobType?: string;
    jobId?: string;
  },
): Promise<Record<string, unknown>> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    cacheScopeId,
    cacheTtlMs,
    initiatedByUserId,
    jobType,
    jobId: logicalJobId,
  } = options ?? {};

  if (signal?.aborted) throw new Error("Job cancelled");

  const fileBuffer = extractFile(zipBuffer, entryPath);
  if (!fileBuffer) throw new Error(`Job entry not found in zip: ${entryPath}`);

  const resolvedCacheScope = cacheScopeId ?? entryPath;
  const cacheKey = stableStringify({
    entryHash: createHash("sha256").update(fileBuffer).digest("hex"),
    inputs,
  });
  const cachedOutputs = await readCachedOutputs(resolvedCacheScope, cacheKey);
  if (cachedOutputs) return cachedOutputs;

  const queuedAt = Date.now();
  await acquireJobSlot(signal);
  const queueWait = Date.now() - queuedAt;
  jobsStartedCounter.add(1, { entry_path: entryPath });
  jobQueueWaitMs.record(queueWait, { entry_path: entryPath });

  let jobPath: string | null = null;
  let wrapperPath: string | null = null;
  const startedAt = Date.now();
  let completed = false;

  try {
    const outputs = await withSpan(
      "wiki.job.run",
      {
        attributes: {
          "wiki.space.id": spaceId,
          "wiki.job.entry_path": entryPath,
          "wiki.job.queue_wait_ms": queueWait,
          "wiki.job.type": jobType ?? "unknown",
          "wiki.job.id": logicalJobId ?? cacheScopeId ?? entryPath,
        },
      },
      async (span) => {
        span.setAttribute("wiki.job.inputs_json", toSpanJson(inputs));
        const executionId = crypto.randomUUID();
        span.setAttribute("wiki.job.execution_id", executionId);
        jobPath = join(tmpdir(), `wiki-job-${executionId}.mjs`);
        wrapperPath = join(tmpdir(), `wiki-wrapper-${executionId}.mjs`);

        await writeFile(jobPath, fileBuffer);
        await writeFile(wrapperPath, buildJobWrapper(pathToFileURL(jobPath).href));
        if (!wrapperPath) throw new Error("Failed to create worker wrapper path");

        const timestamp = Date.now().toString();
        const traceHeaders = activeTraceHeaders();

        const workerData = {
          openrouterApiKey: config().OPENROUTER_API_KEY,
          ...inputs,
          jobId: executionId,
          cacheScopeId: cacheScopeId ?? entryPath,
          spaceId,
          apiUrl: import.meta.env.DEV ? "http://127.0.0.1:4321" : "http://127.0.0.1:8080",
          jobToken: createJobToken(spaceId, timestamp, initiatedByUserId ?? null),
          traceparent: traceHeaders.traceparent ?? null,
          tracestate: traceHeaders.tracestate ?? null,
        };
        const resolvedWrapperPath = wrapperPath;

        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          const worker = new Worker(resolvedWrapperPath, { workerData });

          let timer = setTimeout(() => {
            span.setAttribute("wiki.job.timeout", true);
            worker.terminate();
            reject(new Error(`Job timed out after ${timeoutMs / 1000}s of inactivity`));
          }, timeoutMs);

          const resetTimer = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              span.setAttribute("wiki.job.timeout", true);
              worker.terminate();
              reject(new Error(`Job timed out after ${timeoutMs / 1000}s of inactivity`));
            }, timeoutMs);
          };

          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              span.setAttribute("wiki.job.cancelled", true);
              worker.terminate();
              reject(new Error("Job cancelled"));
            },
            { once: true },
          );

          worker.on(
            "message",
            (msg: {
              type?: string;
              success?: boolean;
              outputs?: Record<string, unknown>;
              error?: string;
              message?: string;
            }) => {
              if (msg.type === "log") {
                resetTimer();
                const message = msg.message ?? "";
                onLog?.(message);
              } else if (msg.type === "result") {
                clearTimeout(timer);
                if (msg.success) {
                  const outputs = msg.outputs ?? {};
                  span.setAttribute("wiki.job.outputs_json", toSpanJson(outputs));
                  resolve(outputs);
                } else reject(new Error(msg.error ?? "Job failed without error message"));
              }
            },
          );
          worker.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
      },
    );
    await writeCachedOutputs(resolvedCacheScope, cacheKey, outputs, cacheTtlMs);
    completed = true;
    return outputs;
  } catch (error) {
    jobsFailedCounter.add(1, {
      entry_path: entryPath,
      status: "failed",
    });
    throw error;
  } finally {
    if (Date.now() >= startedAt) {
      jobDurationMs.record(Date.now() - startedAt, { entry_path: entryPath });
    }
    if (completed) {
      jobsCompletedCounter.add(1, { entry_path: entryPath });
    }
    releaseJobSlot();
    await Promise.all([
      jobPath ? unlink(jobPath).catch(() => {}) : Promise.resolve(),
      wrapperPath ? unlink(wrapperPath).catch(() => {}) : Promise.resolve(),
    ]);
  }
}
