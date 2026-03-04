import { Worker } from "node:worker_threads";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extractFile } from "../db/extensions.ts";
import { config } from "../config.ts";
import { createJobToken } from "./jobToken.ts";
import { buildJobWrapper } from "./jobRuntime.ts";

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

function releaseJobSlot(): void {
  activeJobs = Math.max(0, activeJobs - 1);
  const next = waitQueue.shift();
  if (next) {
    activeJobs += 1;
    next();
  }
}

function acquireJobSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Job cancelled"));

  if (activeJobs < MAX_CONCURRENT_JOBS) {
    activeJobs += 1;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    const onAbort = () => {
      const idx = waitQueue.indexOf(start);
      if (idx >= 0) waitQueue.splice(idx, 1);
      reject(new Error("Job cancelled"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    waitQueue.push(start);
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
    initiatedByUserId?: string | null;
  },
): Promise<Record<string, unknown>> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    cacheScopeId,
    initiatedByUserId,
  } = options ?? {};

  await acquireJobSlot(signal);

  let jobPath: string | null = null;
  let wrapperPath: string | null = null;

  try {
    const fileBuffer = extractFile(zipBuffer, entryPath);
    if (!fileBuffer) throw new Error(`Job entry not found in zip: ${entryPath}`);

    const jobId = crypto.randomUUID();
    jobPath = join(tmpdir(), `wiki-job-${jobId}.mjs`);
    wrapperPath = join(tmpdir(), `wiki-wrapper-${jobId}.mjs`);

    await writeFile(jobPath, fileBuffer);
    await writeFile(wrapperPath, buildJobWrapper(pathToFileURL(jobPath).href));
    if (!wrapperPath) throw new Error("Failed to create worker wrapper path");

    const timestamp = Date.now().toString();

    const workerData = {
      openrouterApiKey: config().OPENROUTER_API_KEY,
      ...inputs,
      jobId,
      cacheScopeId: cacheScopeId ?? entryPath,
      spaceId,
      apiUrl: import.meta.env.DEV ? "http://127.0.0.1:4321" : "http://127.0.0.1:8080",
      jobToken: createJobToken(spaceId, timestamp, initiatedByUserId ?? null),
    };
    const resolvedWrapperPath = wrapperPath;

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const worker = new Worker(resolvedWrapperPath, { workerData });

      let timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`Job timed out after ${timeoutMs / 1000}s of inactivity`));
      }, timeoutMs);

      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          worker.terminate();
          reject(new Error(`Job timed out after ${timeoutMs / 1000}s of inactivity`));
        }, timeoutMs);
      };

      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
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
            console.log(`[job] ${message}`);
            onLog?.(message);
          } else if (msg.type === "result") {
            clearTimeout(timer);
            if (msg.success) resolve(msg.outputs ?? {});
            else reject(new Error(msg.error ?? "Job failed without error message"));
          }
        },
      );
      worker.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    releaseJobSlot();
    await Promise.all([
      jobPath ? unlink(jobPath).catch(() => {}) : Promise.resolve(),
      wrapperPath ? unlink(wrapperPath).catch(() => {}) : Promise.resolve(),
    ]);
  }
}
