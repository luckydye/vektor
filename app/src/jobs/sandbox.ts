import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFile } from "../db/extensions.ts";
import { config, getConfiguredOpenRouterModel, getConfiguredAnthropicModel } from "../config.ts";
import { createJobToken } from "./jobToken.ts";
import { buildSandboxWrapper } from "./sandboxRuntime.ts";
import { activeTraceHeaders } from "../observability/otel.ts";

const exec = promisify(execFile);

export interface Sandbox {
  name: string;
  runJob(
    zipBuffer: Buffer,
    entryPath: string,
    inputs: Record<string, unknown>,
    spaceId: string,
    onLog?: (msg: string) => void,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      initiatedByUserId?: string | null;
    },
  ): Promise<Record<string, unknown>>;
  destroy(): Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
  const name = `wiki-job-${crypto.randomUUID()}`;
  await exec("openshell", ["sandbox", "create", "--name", name]);

  return {
    name,

    async runJob(zipBuffer, entryPath, inputs, spaceId, onLog, options) {
      const { timeoutMs = 15 * 60 * 1000, signal, initiatedByUserId } = options ?? {};

      if (signal?.aborted) throw new Error("Job cancelled");

      const fileBuffer = extractFile(zipBuffer, entryPath);
      if (!fileBuffer) throw new Error(`Job entry not found in zip: ${entryPath}`);

      const executionId = crypto.randomUUID();
      const stagingDir = join(tmpdir(), `wiki-sandbox-${executionId}`);
      await mkdir(stagingDir, { recursive: true });

      const jobPath = join(stagingDir, "job.mjs");
      const wrapperPath = join(stagingDir, "wrapper.mjs");
      const dataPath = join(stagingDir, "data.json");

      // Sandbox jobs hit the backend directly; do not route through the public ingress.
      const apiUrl = import.meta.env.DEV
        ? "http://127.0.0.1:4321"
        : "http://127.0.0.1:8080";
      const timestamp = Date.now().toString();
      const traceHeaders = activeTraceHeaders();

      const workerData = {
        ...inputs,
        openrouterApiKey: config().OPENROUTER_API_KEY,
        openrouterModel: getConfiguredOpenRouterModel(),
        anthropicApiKey: config().ANTHROPIC_API_KEY,
        anthropicModel: getConfiguredAnthropicModel(),
        jobId: executionId,
        spaceId,
        apiUrl,
        jobToken: createJobToken(spaceId, timestamp, initiatedByUserId ?? null),
        traceparent: traceHeaders.traceparent ?? null,
        tracestate: traceHeaders.tracestate ?? null,
      };

      try {
        await writeFile(jobPath, fileBuffer);
        await writeFile(wrapperPath, buildSandboxWrapper("/sandbox/job/job.mjs"));
        await writeFile(dataPath, JSON.stringify(workerData));

        // Upload staging dir to sandbox
        await exec("openshell", [
          "sandbox",
          "upload",
          name,
          stagingDir,
          "/sandbox/job",
        ]);

        // Execute inside sandbox
        const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const child = execFile(
            "openshell",
            ["sandbox", "connect", name, "--", "node", "/sandbox/job/wrapper.mjs"],
            { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, signal },
            (error, stdout) => {
              if (signal?.aborted) return reject(new Error("Job cancelled"));
              if (error) return reject(error);

              // Parse JSON lines from stdout
              const lines = stdout.trim().split("\n").filter(Boolean);
              let outputs: Record<string, unknown> | undefined;

              for (const line of lines) {
                try {
                  const msg = JSON.parse(line);
                  if (msg.type === "log") {
                    onLog?.(msg.message ?? "");
                  } else if (msg.type === "result") {
                    if (msg.success) {
                      outputs = msg.outputs ?? {};
                    } else {
                      return reject(new Error(msg.error ?? "Job failed without error message"));
                    }
                  }
                } catch {
                  // Non-JSON line — treat as log
                  onLog?.(line);
                }
              }

              if (!outputs) return reject(new Error("Job produced no result"));
              resolve(outputs);
            },
          );

          signal?.addEventListener(
            "abort",
            () => {
              child.kill();
              reject(new Error("Job cancelled"));
            },
            { once: true },
          );
        });

        return result;
      } finally {
        await Promise.all([
          unlink(jobPath).catch(() => {}),
          unlink(wrapperPath).catch(() => {}),
          unlink(dataPath).catch(() => {}),
        ]);
        await import("node:fs/promises").then((fs) =>
          fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {}),
        );
      }
    },

    async destroy() {
      await exec("openshell", ["sandbox", "delete", name]).catch(() => {});
    },
  };
}
