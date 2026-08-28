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
import { isSerializedDocumentType } from "#documents/types.ts";
import { inlineHtmlDiff } from "#editor/inlineHtmlDiff.ts";
import { escapeHtml, prettyPrintHtml } from "#utils/html.ts";

async function getRevision(rev: number, spaceId: string, id: string) {
  const metadata = await getRevisionMetadata(await openSpaceStore(spaceId), id, rev);
  if (!metadata) {
    throw notFoundResponse("Revision");
  }

  const content = await getRevisionContent(await openSpaceStore(spaceId), id, rev);
  if (content === null) {
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
    const document = await getDocument(store, id);
    if (!document) {
      throw notFoundResponse("Document");
    }
    const revisionMetadata = await getRevisionMetadata(store, id, rev);
    if (!revisionMetadata) {
      throw notFoundResponse("Revision");
    }

    let compareBaseRev = requestedBaseRev;
    if (compareBaseRev === null) {
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
    if (baseContent === null) {
      throw requestedBaseRev === null
        ? badRequestResponse("Document has no comparable base content")
        : notFoundResponse("Base revision");
    }

    const serialized = isSerializedDocumentType(document.type);
    const sourcePatch = createPatch(id, baseContent, revisionContent);

    // Rich text gets an inline redline. Serialized representations get an
    // escaped source patch: their JSON/source must never enter the HTML parser.
    if (searchParams.get("format") === "html") {
      const html = serialized
        ? `<pre>${escapeHtml(sourcePatch)}</pre>`
        : inlineHtmlDiff(baseContent, revisionContent);
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // Bun omits Content-Length on larger bodies and nginx then waits for
          // a chunked terminator that never comes.
          "Content-Length": Buffer.byteLength(html).toString(),
          "X-Diff-Base-Rev": String(compareBaseRev),
        },
      });
    }

    return new Response(
      serialized
        ? sourcePatch
        : createPatch(
            id,
            prettyPrintHtml(baseContent),
            prettyPrintHtml(revisionContent),
          ),
      { headers: { "X-Diff-Base-Rev": String(compareBaseRev) } },
    );
  }, "Failed to compute revision diff");
