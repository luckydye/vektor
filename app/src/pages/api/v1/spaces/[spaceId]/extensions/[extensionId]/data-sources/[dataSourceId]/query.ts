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

/**
 * POST /api/v1/spaces/:spaceId/extensions/:extensionId/data-sources/:dataSourceId/query
 *
 * Runs an extension-declared data source backed by a job.
 *
 * Body: { inputs?: Record<string, unknown> }
 */
export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.params, "spaceId");
      const extensionId = requireParam(context.params, "extensionId");
      const dataSourceId = requireParam(context.params, "dataSourceId");

      await verifyExtensionAccess(spaceId, extensionId, user.id);

      const ext = await getExtension(spaceId, extensionId);
      if (!ext) return notFoundResponse("Extension");

      const dataSource = ext.manifest.dataSources?.find((ds) => ds.id === dataSourceId);
      if (!dataSource) return notFoundResponse("Data source");

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
        { cacheScopeId: jobDef.id, initiatedByUserId: user.id },
      );

      return jsonResponse({ outputs, logs });
    },
    {
      fallbackMessage: "Failed to query data source",
      onError: (error) => {
        console.error("Query data source error:", error);
        return errorResponse("Failed to query data source", 500);
      },
    },
  );
