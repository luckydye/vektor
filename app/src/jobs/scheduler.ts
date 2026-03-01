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
  const fileBuffer = extractFile(zipBuffer, entryPath);
  if (!fileBuffer) throw new Error(`Job entry not found in zip: ${entryPath}`);

  const jobId = crypto.randomUUID();
  const jobPath = join(tmpdir(), `wiki-job-${jobId}.mjs`);
  const wrapperPath = join(tmpdir(), `wiki-wrapper-${jobId}.mjs`);

  await writeFile(jobPath, fileBuffer);
  await writeFile(wrapperPath, buildJobWrapper(pathToFileURL(jobPath).href));

  const timestamp = Date.now().toString();

  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    cacheScopeId,
    initiatedByUserId,
  } = options ?? {};

  const workerData = {
    openrouterApiKey: config().OPENROUTER_API_KEY,
    ...inputs,
    jobId,
    cacheScopeId: cacheScopeId ?? entryPath,
    spaceId,
    apiUrl: import.meta.env.DEV ? "http://127.0.0.1:4321" : "http://127.0.0.1:8080",
    jobToken: createJobToken(spaceId, timestamp, initiatedByUserId ?? null),
  };

  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const worker = new Worker(wrapperPath, { workerData });

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
    await Promise.all([
      unlink(jobPath).catch(() => {}),
      unlink(wrapperPath).catch(() => {}),
    ]);
  }
}
