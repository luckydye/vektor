import { authenticateJobTokenOrSpaceRole, canAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  createdResponse,
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  parseFormBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import { authorizeExtensionInstall } from "#api/routes/spaces/extensionAuth.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  createExtension,
  type ExtensionManifest,
  getExtension,
  getExtensionSourcePolicy,
  listExtensionsWithErrors,
  updateExtension,
} from "#db/space/extensions.ts";
import { appLogger } from "#observability/logger.ts";

/**
 * GET /api/v1/spaces/:spaceId/extensions
 * List extension metadata in a space.
 * Jobs may list all extensions in the space; user sessions only see extensions they can access.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const auth = await authenticateJobTokenOrSpaceRole(
      context.var.credentials,
      spaceId,
      Permission.EDITOR,
    );

    const store = await openSpaceStore(spaceId);
    const { extensions: allExtensions, errors: manifestErrors } =
      await listExtensionsWithErrors(store, { includeDisabled: true });

    const extensions =
      auth.type === "job"
        ? allExtensions
        : (
            await Promise.all(
              allExtensions.map(async (ext) => {
                const hasAccess = await canAccess(
                  spaceId,
                  { type: ResourceType.EXTENSION, id: ext.id },
                  auth.user.id,
                  Permission.VIEWER,
                );
                return hasAccess ? ext : null;
              }),
            )
          ).filter((ext) => ext !== null);

    return jsonResponse({
      extensions: extensions.map((ext) => ({
        id: ext.id,
        name: ext.manifest.name,
        version: ext.manifest.version,
        description: ext.manifest.description,
        enabled: ext.enabled,
        source: ext.source,
        sourceRef: ext.sourceRef,
        sourcePublisher: ext.sourcePublisher,
        entries: ext.manifest.entries,
        routes: ext.manifest.routes,
        jobs: ext.manifest.jobs,
        createdAt: ext.createdAt.toISOString(),
        updatedAt: ext.updatedAt.toISOString(),
        createdBy: ext.createdBy,
      })),
      errors: manifestErrors,
    });
  }, "Failed to list extensions");

/**
 * POST /api/v1/spaces/:spaceId/extensions
 * Upload a new extension (zip file)
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");

      // Authorize before touching the body: the gate is space-wide and never
      // looks at the manifest, so nothing here needs the upload parsed first.
      const createdBy = await authorizeExtensionInstall(context, spaceId);

      // Enforce the server-wide allowed-sources policy
      const allowedSources = getExtensionSourcePolicy();
      if (!allowedSources.includes("upload")) {
        return forbiddenResponse(
          "This space does not allow uploading extension packages directly. Install extensions from the marketplace instead.",
        );
      }

      // Caller is authorized: now read the upload.
      const formData = await parseFormBody(context.req.raw);
      const file = formData.get("file") as File | null;

      if (!file) {
        return badRequestResponse("No file provided");
      }

      // Validate file type
      if (!file.name.endsWith(".zip") && file.type !== "application/zip") {
        return badRequestResponse("Extension must be a zip file");
      }

      // Max 5MB for extension packages
      const MAX_SIZE = 5 * 1024 * 1024;
      if (file.size > MAX_SIZE) {
        return badRequestResponse("Extension package exceeds maximum size of 5MB");
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      let manifest: ExtensionManifest;
      try {
        const { extractFile } = await import("#db/space/extensions.ts");
        const manifestData = extractFile(buffer, "manifest.json");
        if (!manifestData) {
          return badRequestResponse("Extension package missing manifest.json");
        }
        manifest = JSON.parse(manifestData.toString("utf-8"));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid manifest";
        return badRequestResponse(`Invalid extension package: ${message}`);
      }

      // Use manifest.id as the extension ID
      const extensionId = manifest.id;

      // Check if extension already exists - update it if so
      const store = await openSpaceStore(spaceId);
      const existing = await getExtension(store, extensionId, {
        includeDisabled: true,
      });

      let ext = null;
      try {
        ext = existing
          ? await updateExtension(store, extensionId, buffer)
          : await createExtension(store, extensionId, buffer, createdBy);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid extension package";
        return badRequestResponse(`Invalid extension package: ${message}`);
      }

      if (!ext) {
        return badRequestResponse("Failed to save extension");
      }

      return createdResponse({
        id: ext.id,
        name: ext.manifest.name,
        version: ext.manifest.version,
        description: ext.manifest.description,
        enabled: ext.enabled,
        source: ext.source,
        sourceRef: ext.sourceRef,
        sourcePublisher: ext.sourcePublisher,
        entries: ext.manifest.entries,
        routes: ext.manifest.routes,
        jobs: ext.manifest.jobs,
        createdAt: ext.createdAt.toISOString(),
        updatedAt: ext.updatedAt.toISOString(),
        createdBy: ext.createdBy,
      });
    },
    {
      fallbackMessage: "Failed to upload extension",
      onError: (error) => {
        appLogger.error("Upload extension error", { error });
        return errorResponse("Failed to upload extension", 500);
      },
    },
  );
