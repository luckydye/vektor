import type { ApiRouteHandler } from "#api/server/types.ts";
import { createPatch } from "diff";
import { ResourceType } from "#db/acl.ts";
import {
  authenticateRequest,
  badRequestResponse,
  notFoundResponse,
  parseQueryInt,
  requireParam,
  verifyDocumentRole,
  verifyTokenPermission,
  withApiErrorHandling,
} from "#db/api.ts";
import { getDocument } from "#db/documents.ts";
import { getRevisionContent, getRevisionMetadata } from "#db/revisions.ts";
import { inlineHtmlDiff } from "#utils/inlineHtmlDiff.ts";
import { prettyPrintHtml } from "#utils/prettyHtml.ts";

async function getRevision(rev: number, spaceId: string, id: string) {
  const metadata = await getRevisionMetadata(spaceId, id, rev);
  if (!metadata) {
    throw notFoundResponse("Revision");
  }

  const content = await getRevisionContent(spaceId, id, rev);
  if (!content) {
    throw notFoundResponse("Revision");
  }

  return content;
}

/**
 * Returns a patch from publsihed content to given revision
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");
    const revParam = new URL(context.req.url).searchParams.get("rev");
    if (!revParam) {
      throw badRequestResponse("Revision query parameter is required");
    }
    const rev = parseQueryInt(new URL(context.req.url).searchParams, "rev", { min: 1 });

    // Authenticate with either user session or access token
    const auth = await authenticateRequest(context, spaceId);

    // Handle token-based authentication
    if (auth.type === "token") {
      await verifyTokenPermission(
        auth.token,
        spaceId,
        ResourceType.DOCUMENT,
        id,
        "viewer",
      );
    } else {
      // Handle user-based authentication
      await verifyDocumentRole(spaceId, id, auth.user.id, "viewer");
    }

    const revisionContent = await getRevision(rev, spaceId, id);
    const revisionMetadata = await getRevisionMetadata(spaceId, id, rev);
    if (!revisionMetadata) {
      throw notFoundResponse("Revision");
    }

    const document = await getDocument(spaceId, id);
    if (!document) {
      throw notFoundResponse("Document");
    }

    const compareBaseRev =
      revisionMetadata.status !== null
        ? revisionMetadata.parentRev
        : document.publishedRev;
    if (!compareBaseRev) {
      throw badRequestResponse("Document has no comparable base revision");
    }

    const baseContent = await getRevisionContent(spaceId, id, compareBaseRev);
    if (!baseContent) {
      throw badRequestResponse("Document has no comparable base content");
    }

    // `format=html` returns a rendered, inline redline of the document (added
    // text wrapped in <ins>, removed text in <del>) instead of a source-level
    // unified patch, so the client can display changes in document context.
    if (new URL(context.req.url).searchParams.get("format") === "html") {
      return new Response(inlineHtmlDiff(baseContent, revisionContent), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return new Response(
      createPatch(id, prettyPrintHtml(baseContent), prettyPrintHtml(revisionContent)),
    );
  }, "Failed to compute revision diff");
