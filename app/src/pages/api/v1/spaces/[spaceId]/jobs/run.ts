/**
 * POST /api/v1/spaces/:spaceId/jobs/run
 *
 * Runs a single extension job. jobIds are unique within a space — no extensionId required.
 *
 * Auth: X-Job-Token (job-to-job) OR user session (requires editor role).
 *
 * Body: { jobId: string, inputs?: Record<string, unknown>, stream?: boolean }
 *
 * Default:          runs inline, returns { outputs, logs }
 * Stream (stream:true): SSE stream with events:
 *   data: { type: "log",    message: string }
 *   data: { type: "output", outputs: Record<string, unknown> }
 *   data: { type: "error",  error: string }
 *   data: [DONE]
 */
import type { APIRoute } from "astro";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#db/api.ts";
import { listExtensions, getExtensionPackage } from "#db/extensions.ts";
import { appLogger } from "#observability/logger.ts";
import { runJob } from "../../../../../../jobs/scheduler.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";
import { config } from "../../../../../../config.ts";
import { createSandbox } from "../../../../../../jobs/sandbox.ts";

export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async (span) => {
      const spaceId = requireParam(context.params, "spaceId");

      // Auth: job token OR user session
      const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");
      const initiatedByUserId = auth.type === "user" ? auth.user.id : auth.userId;

      const body = await parseJsonBody<{
        jobId?: string;
        inputs?: Record<string, unknown>;
        stream?: boolean;
      }>(context.request);
      const { jobId, inputs = {} } = body;
      if (jobId) span?.setAttribute("wiki.job.id", jobId);

      if (!jobId) return badRequestResponse("jobId is required");

      // Resolve job across all extensions in the space
      const extensions = await listExtensions(spaceId);
      let extensionId: string | undefined;
      let entry: string | undefined;
      for (const ext of extensions) {
        const jobDef = ext.manifest.jobs?.find((j) => j.id === jobId);
        if (jobDef) {
          extensionId = ext.id;
          entry = jobDef.entry;
          break;
        }
      }

      if (!extensionId || !entry) return badRequestResponse(`Job "${jobId}" not found`);

      const zipBuffer = await getExtensionPackage(spaceId, extensionId);
      if (!zipBuffer)
        return badRequestResponse(`Extension package not found for job "${jobId}"`);

      const useSandbox = config().JOB_SANDBOX === "openshell";
      const sandbox = useSandbox ? await createSandbox() : null;

      if (body.stream) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (data: unknown) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            };

            try {
              const outputs = await runJob(
                zipBuffer,
                entry,
                inputs,
                spaceId,
                (message) => send({ type: "log", message }),
                {
                  signal: context.request.signal,
                  initiatedByUserId,
                  jobType: "single_job",
                  jobId,
                  sandbox,
                },
              );
              send({ type: "output", outputs });
            } catch (err) {
              const error = err instanceof Error ? err.message : "Job run failed";
              send({ type: "error", error });
            } finally {
              await sandbox?.destroy();
            }

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // Sync mode: run inline and return outputs
      const logs: string[] = [];
      try {
        const outputs = await runJob(
          zipBuffer,
          entry,
          inputs,
          spaceId,
          (msg) => logs.push(msg),
          {
            initiatedByUserId,
            jobType: "single_job",
            jobId,
            sandbox,
          },
        );

        return jsonResponse({ outputs, logs });
      } finally {
        await sandbox?.destroy();
      }
    },
    {
      fallbackMessage: "Job run failed",
      telemetry: {
        context,
        spanName: "api.jobs.run",
        attributes: {
          "http.method": "POST",
          "http.route": "/api/v1/spaces/:spaceId/jobs/run",
        },
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        appLogger.error("Job run error", { error: message });
        return errorResponse(message, 500);
      },
    },
  );
