import {
  authenticateRequest,
  verifyFeatureAccess,
  verifyTokenFeature,
} from "#acl/guards.ts";
import { resolveIdentity } from "#acl/identity.ts";
import { Feature } from "#acl/permissions.ts";
import { hasFeature } from "#acl/store.ts";
import { forbiddenResponse } from "#api/http.ts";
import type { ApiContext } from "#api/server/types.ts";
import { parseJobToken } from "#jobs/jobToken.ts";

/**
 * Authorize adding an extension to a space, whichever way it arrives.
 *
 * Installing from the store and uploading a zip are the same privileged act —
 * either way the extension's code runs in every member's browser — so both go
 * through this one gate rather than two that could drift apart. The gate is the
 * space-wide `manage_extensions` capability and never looks at *which*
 * extension is involved, so it is safe (and required) to call it before reading
 * a request body: an unauthorized caller must not be able to make the server
 * parse a multipart upload and unzip an archive.
 *
 * Returns the user id to record as the installer.
 */
export async function authorizeExtensionInstall(
  context: ApiContext,
  spaceId: string,
): Promise<string> {
  const jobTokenHeader = context.req.raw.headers.get("X-Job-Token");
  if (jobTokenHeader) {
    const parsed = parseJobToken(jobTokenHeader, spaceId);
    if (!parsed) throw forbiddenResponse("Invalid job token");
    // A job token is a delegated credential, so anonymous system tokens are
    // rejected outright and user-scoped ones must actually hold the capability.
    if (!parsed.userId) {
      throw forbiddenResponse(
        "Anonymous job tokens are not allowed to install extensions",
      );
    }
    const canManage = await hasFeature(
      spaceId,
      Feature.MANAGE_EXTENSIONS,
      await resolveIdentity(parsed.userId),
    );
    if (!canManage) {
      throw forbiddenResponse(
        "Job token user does not have the manage_extensions capability",
      );
    }
    return parsed.userId;
  }

  const auth = await authenticateRequest(context.var.credentials, spaceId);
  if (auth.type === "user") {
    // The `owner` role holds `manage_extensions` by default (DEFAULT_FEATURES in
    // #acl/permissions.ts, which the client-side gate reads too), so a granted
    // co-owner may install, not only the original space creator.
    await verifyFeatureAccess(spaceId, Feature.MANAGE_EXTENSIONS, auth.user.id);
    return auth.user.id;
  }

  // Tokens need the same space-wide capability — a plain viewer/editor token
  // will not do. It is space-scoped (no resource id), so it covers installing an
  // extension the space has never seen. This is the path the CLI takes.
  await verifyTokenFeature(auth.token, spaceId, Feature.MANAGE_EXTENSIONS);
  return auth.token.token.createdBy;
}
