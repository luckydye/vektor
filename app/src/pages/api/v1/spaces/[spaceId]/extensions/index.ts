import type { APIRoute } from "astro";
import {
  badRequestResponse,
  canAccessExtension,
  createdResponse,
  errorResponse,
  jsonResponse,
  requireParam,
  verifySpaceOwnership,
  withApiErrorHandling,
} from "#db/api.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";
import { getSpace } from "#db/spaces.ts";
import {
  createExtension,
  listExtensionsWithErrors,
  getExtension,
  updateExtension,
  type ExtensionManifest,
} from "#db/extensions.ts";

/**
 * GET /api/v1/spaces/:spaceId/extensions
 * List extension metadata in a space.
 * Jobs may list all extensions in the space; user sessions only see extensions they can access.
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");

    const {
      extensions: allExtensions,
      errors: manifestErrors,
    } = await listExtensionsWithErrors(spaceId);

    const extensions =
      auth.type === "job"
        ? allExtensions
        : (
            await Promise.all(
              allExtensions.map(async (ext) => {
                const hasAccess = await canAccessExtension(spaceId, ext.id, auth.user.id);
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
export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.params, "spaceId");
      const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "owner");

      let createdBy: string;
      if (auth.type === "user") {
        await verifySpaceOwnership(spaceId, auth.user.id, getSpace);
        createdBy = auth.user.id;
      } else {
        createdBy = auth.userId ?? "agent";
      }

      const formData = await context.request.formData();
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

      // extractManifest is called inside createExtension and will throw if invalid
      let manifest: ExtensionManifest;
      try {
        const { extractFile } = await import("#db/extensions.ts");
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
      const existing = await getExtension(spaceId, extensionId);

      let ext = null;
      try {
        ext = existing
          ? await updateExtension(spaceId, extensionId, buffer)
          : await createExtension(spaceId, extensionId, buffer, createdBy);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Invalid extension package";
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
        console.error("Upload extension error:", error);
        return errorResponse("Failed to upload extension", 500);
      },
    },
  );
