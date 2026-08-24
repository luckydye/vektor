import { createPatch } from "diff";
import { authenticateDocumentAccess, verifyRevisionAccess } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  notFoundResponse,
  parseQueryInt,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getDocument } from "#db/space/documents.ts";
import { getRevisionContent, getRevisionMetadata } from "#db/space/revisions.ts";
import { inlineHtmlDiff } from "#editor/inlineHtmlDiff.ts";
import { prettyPrintHtml } from "#utils/html.ts";

async function getRevision(rev: number, spaceId: string, id: string) {
  const metadata = await getRevisionMetadata(await openSpaceStore(spaceId), id, rev);
  if (!metadata) {
    throw notFoundResponse("Revision");
  }

  const content = await getRevisionContent(await openSpaceStore(spaceId), id, rev);
  if (!content) {
    throw notFoundResponse("Revision");
  }

  return content;
}

/**
 * Returns a patch between two revisions: `rev` against `base`, defaulting to
 * the revision this one was meant to change (its parent for a suggestion, the
 * published revision otherwise). The resolved base comes back in
 * `X-Diff-Base-Rev` so a caller that took the default can name both sides of
 * the comparison — the viewer puts them in its URL.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");
    const searchParams = new URL(context.req.url).searchParams;
    const revParam = searchParams.get("rev");
    if (!revParam) {
      throw badRequestResponse("Revision query parameter is required");
    }
    const rev = parseQueryInt(searchParams, "rev", { min: 1 });
    const baseParam = searchParams.get("base");
    const requestedBaseRev =
      baseParam === null || baseParam.trim() === ""
        ? null
        : parseQueryInt(searchParams, "base", { min: 1 });

    const { aclUserId } = await authenticateDocumentAccess(
      context.var.credentials,
      spaceId,
      id,
      Permission.VIEWER,
    );

    // Both sides are content, so both are held to the `?rev=N` rule.
    await verifyRevisionAccess(spaceId, id, aclUserId, [rev]);

    const revisionContent = await getRevision(rev, spaceId, id);
    const store = await openSpaceStore(spaceId);
    const revisionMetadata = await getRevisionMetadata(store, id, rev);
    if (!revisionMetadata) {
      throw notFoundResponse("Revision");
    }

    let compareBaseRev = requestedBaseRev;
    if (compareBaseRev === null) {
      const document = await getDocument(store, id);
      if (!document) {
        throw notFoundResponse("Document");
      }

      compareBaseRev =
        revisionMetadata.status !== null
          ? revisionMetadata.parentRev
          : document.publishedRev;
    }
    if (!compareBaseRev) {
      throw badRequestResponse("Document has no comparable base revision");
    }
    await verifyRevisionAccess(spaceId, id, aclUserId, [compareBaseRev]);

    const baseContent = await getRevisionContent(store, id, compareBaseRev);
    if (!baseContent) {
      throw requestedBaseRev === null
        ? badRequestResponse("Document has no comparable base content")
        : notFoundResponse("Base revision");
    }

    // `format=html` returns a rendered, inline redline of the document (added
    // text wrapped in <ins>, removed text in <del>) instead of a source-level
    // unified patch, so the client can display changes in document context.
    if (searchParams.get("format") === "html") {
      const html = inlineHtmlDiff(baseContent, revisionContent);
      return new Response(html, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          // Bun omits Content-Length on larger bodies and nginx then waits for
          // a chunked terminator that never comes.
          "Content-Length": Buffer.byteLength(html).toString(),
          "X-Diff-Base-Rev": String(compareBaseRev),
        },
      });
    }

    return new Response(
      createPatch(id, prettyPrintHtml(baseContent), prettyPrintHtml(revisionContent)),
      { headers: { "X-Diff-Base-Rev": String(compareBaseRev) } },
    );
  }, "Failed to compute revision diff");
