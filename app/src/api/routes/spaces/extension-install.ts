import {
  badRequestResponse,
  createdResponse,
  forbiddenResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import { registryErrorResponse } from "#api/routes/marketplace/errors.ts";
import { authorizeExtensionInstall } from "#api/routes/spaces/extensionAuth.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  createExtension,
  getExtension,
  getExtensionSourcePolicy,
  updateExtension,
} from "#db/space/extensions.ts";
import { downloadRegistryPackage } from "#extensions/registry.ts";
import { appLogger } from "#observability/logger.ts";

interface InstallBody {
  extensionId?: unknown;
  /** Omit to install whatever the store currently calls latest. */
  version?: unknown;
}

/**
 * POST /api/v1/spaces/:spaceId/extensions/install
 * Install (or update to) a version of a store extension.
 *
 * The caller names an extension, never a URL: the server resolves the version
 * through the registry's own documents, downloads it, and verifies the
 * published checksum before the package is unzipped. The result is stored with
 * `source: "marketplace"` so the space can tell later where its code came from
 * — and so an operator who allows only `marketplace` can prove nothing was
 * side-loaded.
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");

    // Same gate as a direct upload — the CLI reaches this with an access token.
    const installedBy = await authorizeExtensionInstall(context, spaceId);

    if (!getExtensionSourcePolicy().includes("marketplace")) {
      return forbiddenResponse(
        "This server does not allow installing extensions from a store.",
      );
    }

    const body = await parseJsonBody<InstallBody>(context.req.raw);
    const extensionId = body.extensionId;
    if (typeof extensionId !== "string" || !extensionId.trim()) {
      return badRequestResponse("extensionId is required");
    }
    if (body.version !== undefined && typeof body.version !== "string") {
      return badRequestResponse("version must be a string");
    }

    let resolved: Awaited<ReturnType<typeof downloadRegistryPackage>>;
    try {
      resolved = await downloadRegistryPackage(extensionId.trim(), body.version);
    } catch (error) {
      return registryErrorResponse(error);
    }

    const { detail, version, buffer } = resolved;

    const store = await openSpaceStore(spaceId);
    const existing = await getExtension(store, detail.id, { includeDisabled: true });

    // Provenance is rewritten on every install, including over a package that
    // was side-loaded earlier: what matters is where the bytes now installed
    // came from, not where an older build did.
    const source = {
      source: "marketplace" as const,
      sourceRef: `${detail.id}@${version.version}`,
      sourcePublisher: detail.publisher,
    };

    let ext: Awaited<ReturnType<typeof createExtension>> | null;
    try {
      ext = existing
        ? await updateExtension(store, detail.id, buffer, source)
        : await createExtension(store, detail.id, buffer, installedBy, source);
    } catch (error) {
      // The manifest inside the package is re-validated on the way in, so a
      // registry that serves a broken build fails here rather than installing.
      const message = error instanceof Error ? error.message : "Invalid package";
      appLogger.warn("Store extension failed validation", {
        extensionId: detail.id,
        version: version.version,
        error,
      });
      return badRequestResponse(`Invalid extension package: ${message}`);
    }

    if (!ext) {
      return badRequestResponse("Failed to save extension");
    }

    appLogger.info("Installed extension from the store", {
      spaceId,
      extensionId: ext.id,
      version: ext.manifest.version,
      publisher: detail.publisher,
      userId: installedBy,
    });

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
  }, "Failed to install extension");
