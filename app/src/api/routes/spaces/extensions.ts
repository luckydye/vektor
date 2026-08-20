import {
  authenticateJobTokenOrSpaceRole,
  authenticateRequest,
  canAccess,
  verifyFeatureAccess,
  verifyTokenFeature,
} from "#acl/guards.ts";
import { Feature, Permission, ResourceType } from "#acl/permissions.ts";
import { hasFeature } from "#acl/store.ts";
import { requestCredentials } from "#api/acl.ts";
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
import { parseJobToken } from "#jobs/jobToken.ts";
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
      requestCredentials(context),
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

      // Authorize before touching the body. The gate below is the space-wide
      // `manage_extensions` capability and never looks at which extension is
      // being installed, so nothing here needs the manifest — and an
      // unauthorized caller must not be able to make the server parse a
      // multipart upload and unzip an archive.
      let createdBy: string;
      const jobTokenHeader = context.req.raw.headers.get("X-Job-Token");
      if (jobTokenHeader) {
        const parsed = parseJobToken(jobTokenHeader, spaceId);
        if (!parsed) throw forbiddenResponse("Invalid job token");
        // A job token is a delegated credential. Installing an extension is a
        // privileged, space-wide action (the new extension's code runs in
        // every member's browser), so anonymous system tokens are rejected
        // outright and user-scoped tokens must actually hold the
        // `manage_extensions` capability — the same gate the access-token
        // branch enforces below.
        if (!parsed.userId) {
          throw forbiddenResponse(
            "Anonymous job tokens are not allowed to install extensions",
          );
        }
        const canManage = await hasFeature(
          spaceId,
          Feature.MANAGE_EXTENSIONS,
          parsed.userId,
        );
        if (!canManage) {
          throw forbiddenResponse(
            "Job token user does not have the manage_extensions capability",
          );
        }
        createdBy = parsed.userId;
      } else {
        const auth = await authenticateRequest(requestCredentials(context), spaceId);
        if (auth.type === "user") {
          // Installing an extension runs its code in every member's browser, so
          // it is gated on the space-wide `manage_extensions` capability rather
          // than on being the space creator. The `owner` role holds this by
          // default (see DEFAULT_FEATURES in #acl/permissions.ts, which the
          // client-side gate reads too) — so a granted co-owner, not only the
          // original creator, may upload.
          await verifyFeatureAccess(spaceId, Feature.MANAGE_EXTENSIONS, auth.user.id);
          createdBy = auth.user.id;
        } else {
          // Tokens may install/update extensions only with the space-wide
          // `manage_extensions` capability — not a plain viewer/editor token.
          // It's space-scoped (no resource id), so it can publish NEW
          // extensions too. Space owners install via the user-session branch.
          await verifyTokenFeature(auth.token, spaceId, Feature.MANAGE_EXTENSIONS);
          createdBy = auth.token.token.createdBy;
        }
      }

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
