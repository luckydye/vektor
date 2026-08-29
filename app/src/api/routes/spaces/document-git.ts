/**
 * Reading a repository document: the tree, a file, the log.
 *
 * Nested under the document because that is what a repository is — so access is
 * decided by the same guard as any other document, and a per-document grant or
 * a share link reaches the browser exactly as it reaches the clone URL.
 */

import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getDocument } from "#db/space/documents.ts";
import { repositoryDocumentType } from "#documents/types.ts";
import { mimeTypeForExtension } from "#files/fileTypes.ts";
import { getFileStorage } from "#files/storage.ts";
import { blob, isSafePath, isSafeRev, log, overview, raw, tree } from "#git/plumbing.ts";
import { servedFileSecurityHeaders } from "#utils/csp.ts";

/** Commits a single request will return, however many are asked for. */
const MAX_LOG = 100;

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");
    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: documentId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const document = await getDocument(store, documentId);
    if (!document || document.type !== repositoryDocumentType) {
      throw notFoundResponse("Repository");
    }

    const query = new URL(context.req.url).searchParams;
    const rev = query.get("rev") ?? "main";
    const path = query.get("path") ?? "";
    if (!isSafeRev(rev)) throw badRequestResponse("Invalid rev");
    if (!isSafePath(path)) throw badRequestResponse("Invalid path");

    const storage = getFileStorage();
    // Every repository starts on `main`; what a client pushed first is what the
    // stored state records, and `overview` reports which branch that left.
    const branch = "main";

    switch (query.get("view") ?? "overview") {
      case "overview": {
        const summary = await overview(storage, spaceId, documentId, branch);
        return jsonResponse(summary ?? { empty: true, branch, branches: [], head: null });
      }
      case "tree": {
        const entries = await tree(storage, spaceId, documentId, branch, rev, path);
        if (!entries) throw notFoundResponse("Tree");
        return jsonResponse({ entries });
      }
      case "blob": {
        if (path === "") throw badRequestResponse("A blob needs a path");
        const file = await blob(storage, spaceId, documentId, branch, rev, path);
        if (!file) throw notFoundResponse("File");
        return jsonResponse(file);
      }
      case "raw": {
        if (path === "") throw badRequestResponse("A file needs a path");
        const bytes = await raw(storage, spaceId, documentId, branch, rev, path);
        if (!bytes) throw notFoundResponse("File");

        const name = path.split("/").pop() ?? "";
        const extension = name.includes(".") ? name.split(".").pop() : undefined;
        // The same hardening uploads get: repository content is written by
        // whoever can push, so an SVG or HTML file must not be able to run as
        // a document on this origin.
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": mimeTypeForExtension(extension),
            "Content-Length": String(bytes.byteLength),
            "Cache-Control": "private, max-age=300",
            ...servedFileSecurityHeaders(extension, name),
          },
        });
      }
      case "log": {
        const requested = Number(query.get("limit") ?? "30");
        const limit = Number.isInteger(requested)
          ? Math.min(Math.max(requested, 1), MAX_LOG)
          : 30;
        return jsonResponse({
          commits: await log(storage, spaceId, documentId, branch, rev, limit),
        });
      }
      default:
        throw badRequestResponse("Unknown view");
    }
  });
