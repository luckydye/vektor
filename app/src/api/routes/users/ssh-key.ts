/**
 * DELETE /api/v1/users/ssh-keys/:keyId
 *
 * Removes one of the caller's own SSH keys. Deletion is the revocation: no
 * further login can be made with it, though tokens it already minted keep
 * working until they expire or are revoked in the token list.
 */

import {
  notFoundResponse,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { deleteUserSshKey } from "#db/auth/sshKeys.ts";

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const keyId = requireParam(context.var.params, "keyId");

    if (!(await deleteUserSshKey(user.id, keyId))) {
      throw notFoundResponse("SSH key");
    }
    return successResponse();
  }, "Failed to delete SSH key");
