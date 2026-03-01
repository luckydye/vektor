import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifyExtensionAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { listStorageEntries } from "#db/extensionStorage.ts";

/**
 * GET /api/v1/spaces/:spaceId/extensions/:extensionId/storage
 * List all storage entries for an extension, optionally filtered by prefix
 *
 * Query params:
 *   - prefix: Filter keys by prefix (optional)
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const extensionId = requireParam(context.params, "extensionId");

    await verifyExtensionAccess(spaceId, extensionId, user.id);

    const url = new URL(context.request.url);
    const prefix = url.searchParams.get("prefix") ?? undefined;

    const entries = await listStorageEntries(spaceId, extensionId, prefix);

    return jsonResponse(
      entries.map((entry) => ({
        key: entry.key,
        value: entry.value,
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
      })),
    );
  }, "Failed to list storage entries");
