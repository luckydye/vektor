import { createPatch } from "diff";
import type { APIRoute } from "astro";
import {
  badRequestResponse,
  notFoundResponse,
  parseQueryInt,
  requireParam,
  verifyDocumentRole,
  authenticateRequest,
  verifyTokenPermission,
  withApiErrorHandling,
} from "#db/api.ts";
import { ResourceType } from "#db/acl.ts";
import { getDocument } from "#db/documents.ts";
import {
  getPublishedContent,
  getRevisionContent,
  getRevisionMetadata,
} from "#db/revisions.ts";
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
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "documentId");
    const revParam = context.url.searchParams.get("rev");
    if (!revParam) {
      throw badRequestResponse("Revision query parameter is required");
    }
    const rev = parseQueryInt(context.url.searchParams, "rev", { min: 1 });

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
      revisionMetadata.status !== null ? revisionMetadata.parentRev : document.publishedRev;
    if (!compareBaseRev) {
      throw badRequestResponse("Document has no comparable base revision");
    }

    const baseContent = await getRevisionContent(spaceId, id, compareBaseRev);
    if (!baseContent) {
      throw badRequestResponse("Document has no comparable base content");
    }

    return new Response(
      createPatch(
        id,
        prettyPrintHtml(baseContent),
        prettyPrintHtml(revisionContent),
      ),
    );
  }, "Failed to compute revision diff");
