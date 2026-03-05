import type { APIRoute } from "astro";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBodyOrEmpty,
  requireParam,
  requireUser,
  verifyExtensionAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { getExtension, getExtensionPackage } from "#db/extensions.ts";
import { runJob } from "#jobs/scheduler.ts";
import { appLogger } from "#observability/logger.ts";

/**
 * POST /api/v1/spaces/:spaceId/extensions/:extensionId/data-sources/:dataSourceId/query
 *
 * Runs an extension-declared data source backed by a job.
 *
 * Body: { inputs?: Record<string, unknown> }
 */
export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async (span) => {
      const user = requireUser(context);
      const spaceId = requireParam(context.params, "spaceId");
      const extensionId = requireParam(context.params, "extensionId");
      const dataSourceId = requireParam(context.params, "dataSourceId");
      span?.setAttribute("wiki.extension.id", extensionId);
      span?.setAttribute("wiki.data_source.id", dataSourceId);

      await verifyExtensionAccess(spaceId, extensionId, user.id);

      const ext = await getExtension(spaceId, extensionId);
      if (!ext) return notFoundResponse("Extension");

      const dataSource = ext.manifest.dataSources?.find((ds) => ds.id === dataSourceId);
      if (!dataSource) return notFoundResponse("Data source");
      span?.setAttribute("wiki.job.id", dataSource.jobId);

      const jobDef = ext.manifest.jobs?.find((job) => job.id === dataSource.jobId);
      if (!jobDef) {
        return badRequestResponse(
          `Data source '${dataSourceId}' references unknown job '${dataSource.jobId}'`,
        );
      }

      const zipBuffer = await getExtensionPackage(spaceId, extensionId);
      if (!zipBuffer) return badRequestResponse("Extension package not found");

      const body = await parseJsonBodyOrEmpty<{
        inputs?: Record<string, unknown>;
      }>(context.request);
      const inputs = body.inputs ?? {};

      const logs: string[] = [];
      const outputs = await runJob(
        zipBuffer,
        jobDef.entry,
        inputs,
        spaceId,
        (message) => logs.push(message),
        {
          cacheScopeId: jobDef.id,
          initiatedByUserId: user.id,
          jobType: "data_source",
          jobId: jobDef.id,
        },
      );

      return jsonResponse({ outputs, logs });
    },
    {
      fallbackMessage: "Failed to query data source",
      telemetry: {
        context,
        spanName: "api.extensions.data_source.query",
        attributes: {
          "http.method": "POST",
          "http.route":
            "/api/v1/spaces/:spaceId/extensions/:extensionId/data-sources/:dataSourceId/query",
        },
      },
      onError: (error) => {
        appLogger.error("Query data source error", {
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResponse("Failed to query data source", 500);
      },
    },
  );
