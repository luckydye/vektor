import { eq } from "drizzle-orm";
import {
  authenticateDocumentAccess,
  authenticateJobTokenOrSpaceRole,
  authenticateRequest,
  verifyAccess,
  verifyFeatureAccess,
  verifyRevisionAccess,
} from "#acl/guards.ts";
import { Feature, Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  parseQueryInt,
  requireParam,
  requireUser,
  successResponse,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import {
  documentEtag,
  expectedSeqs,
  matchesWeak,
  notModified,
  preconditionFailed,
  PRIVATE_REVALIDATE,
  revisionEtag,
} from "#api/conditional.ts";
import type { ApiContext, ApiRouteHandler } from "#api/server/types.ts";
import { one } from "#db/client/query.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { document as documentTable } from "#db/schema/space.ts";
import { createAuditLog } from "#db/space/auditLogs.ts";
import { touchDocument } from "#db/space/changeSeq.ts";
import {
  archiveDocument,
  type DocumentMeta,
  deleteDocument,
  getDocument,
  getDocumentBySlug,
  getDocumentContent,
  InvalidDocumentParentError,
  restoreDocument,
  setDocumentParent,
  updateDocument,
} from "#db/space/documents.ts";
import { getUploadImageAspectRatio } from "#db/space/files.ts";
import { patchDocumentProperties } from "#db/space/properties.ts";
import {
  createRevision,
  createSuggestion,
  getRevisionContent,
  getRevisionMetadata,
  resolvePublishedDocumentContent,
} from "#db/space/revisions.ts";
import { getSpace, getSpaceBySlug } from "#db/space/spaces.ts";
import { getMimeType, prepareDocumentContent } from "#documents/content.ts";
import {
  type DocumentPropertyPatch,
  InvalidDocumentPropertyPatchError,
  ReservedDocumentPropertyKeyError,
} from "#documents/properties.ts";
import {
  documentIsReadonly,
  isSerializedDocumentType,
  workflowRunDocumentType,
} from "#documents/types.ts";
import { parseJobToken } from "#jobs/jobToken.ts";
import { enqueueDocumentPublishedEmails } from "#notifications/enqueue.ts";
import { appLogger } from "#observability/logger.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import {
  getLiveDocumentContent,
  persistYRoomDraft,
  replaceLiveDocumentContent,
  roomKey,
  setYRoomWriteBlocked,
} from "#realtime/yjsRooms.ts";
import { htmlToMarkdown } from "#utils/markdown.ts";

type DocumentPatchBody = {
  properties?: DocumentPropertyPatch;
  parentId?: string | null;
  publishedRev?: number | null;
  readonly?: boolean;
};

const documentPatchFields = new Set<keyof DocumentPatchBody>([
  "properties",
  "parentId",
  "publishedRev",
  "readonly",
]);

function parseDocumentPatchBody(value: unknown): DocumentPatchBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestResponse("Document patch body must be an object");
  }

  const keys = Object.keys(value);
  const unknownFields = keys.filter(
    (key) => !documentPatchFields.has(key as keyof DocumentPatchBody),
  );
  if (unknownFields.includes("restore")) {
    throw badRequestResponse(
      "restore cannot be patched; use PUT to restore an archived document",
    );
  }
  if (unknownFields.includes("archived")) {
    throw badRequestResponse(
      "archived cannot be patched; use DELETE to archive a document",
    );
  }
  if (unknownFields.length > 0) {
    throw badRequestResponse(
      `Unknown document patch field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`,
    );
  }
  if (keys.length !== 1) {
    throw badRequestResponse(
      "Document patch must contain exactly one of properties, parentId, publishedRev, or readonly",
    );
  }

  return value as DocumentPatchBody;
}

/**
 * The sequences an `If-Match` on this request would accept, or `undefined` when
 * it carries no condition.
 *
 * A request without the header writes unconditionally, which is exactly what
 * every caller predating this did — so absent headers keep their behaviour.
 * `*` collapses to the same thing here, because it asks only that the document
 * exist and each of these handlers has already established that.
 */
function requestedCondition(context: ApiContext): number[] | undefined {
  const header = context.req.raw.headers.get("if-match");
  if (!header) return undefined;
  const seqs = expectedSeqs(header);
  return seqs === "any" ? undefined : seqs;
}

/**
 * Answer a refused condition with the document as it now stands.
 *
 * Read after the failed write rather than before it, so the caller is handed
 * the state that beat it rather than the one it already knew about. Metadata
 * only: the content is what made the response worth omitting in the first place.
 */
async function conflictResponse(store: SpaceStore, id: string): Promise<Response> {
  const current = await getDocument(store, id);
  if (!current) throw notFoundResponse("Document");
  return preconditionFailed(current, documentEtag(current.changeSeq));
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, If-Match, If-None-Match");
  // A browser hides every response header not named here, so without this a
  // cross-origin caller cannot read the tag it is expected to send back.
  headers.set("Access-Control-Expose-Headers", "ETag");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handlePublishedRevisionPatch(
  store: SpaceStore,
  documentId: string,
  userId: string,
  publishedRev: number | null,
) {
  const { spaceId } = store;
  const revToPublish = publishedRev === null ? null : publishedRev;

  const existing = await one(
    store.db
      .select({ publishedRev: documentTable.publishedRev, type: documentTable.type })
      .from(documentTable)
      .where(eq(documentTable.id, documentId)),
  );
  if (existing?.publishedRev === revToPublish) {
    return;
  }

  const revisionContent =
    revToPublish === null
      ? null
      : await getRevisionContent(store, documentId, revToPublish);
  if (revToPublish !== null && revisionContent === null) {
    throw notFoundResponse("Revision");
  }

  const auditEntry = await store.tx(async (tx) => {
    // Publishing changes which body a plain read of this document returns, so
    // it moves the sequence like any other write. Both statements are one
    // logical change, so they share the one allocation the second makes.
    await touchDocument(tx, documentId, { publishedRev: revToPublish });

    const entry = await createAuditLog(tx, {
      spaceId,
      docId: documentId,
      revisionId: revToPublish || undefined,
      userId,
      event: revToPublish === null ? "unpublish" : "publish",
      details: {
        message:
          revToPublish === null
            ? "Document unpublished"
            : `Published revision ${revToPublish}`,
      },
    });

    if (revisionContent !== null) {
      // Publishing a revision also loads it into the draft, so the editor
      // reflects the revision that is now published.
      await touchDocument(tx, documentId, { content: revisionContent });
    }

    return entry;
  });

  if (revToPublish === null) {
    return;
  }

  if (revisionContent === null) throw notFoundResponse("Revision");

  // An open room outranks the stored content for every reader and persists
  // itself back over this write, so the draft only really changes once the live
  // document does.
  replaceLiveDocumentContent(spaceId, documentId, existing?.type, revisionContent);

  try {
    await enqueueDocumentPublishedEmails({
      spaceId,
      documentId,
      publicationId: auditEntry.id,
      revision: revToPublish,
      previousPublishedRevision: existing?.publishedRev ?? null,
      documentType: existing?.type,
      publishedContent: revisionContent,
      actorId: userId,
    });
  } catch (error) {
    appLogger.error("Failed to enqueue document publication emails", {
      error,
      spaceId,
      documentId,
      revision: revToPublish,
    });
  }
}

async function handleReadonlyPatch(
  store: SpaceStore,
  documentId: string,
  userId: string,
  readonly: boolean,
) {
  const { spaceId } = store;
  if (typeof readonly !== "boolean") {
    throw badRequestResponse("Readonly must be a boolean");
  }

  const previousWriteBlock = readonly
    ? setYRoomWriteBlocked(spaceId, documentId, true)
    : false;

  try {
    if (readonly) await persistYRoomDraft(roomKey(spaceId, documentId));

    await store.tx(async (tx) => {
      await touchDocument(tx, documentId, { readonly });

      await createAuditLog(tx, {
        spaceId,
        docId: documentId,
        userId,
        event: readonly ? "lock" : "unlock",
        details: {
          message: readonly ? "Document set to readonly" : "Document readonly removed",
        },
      });
    });

    if (!readonly) setYRoomWriteBlocked(spaceId, documentId, false);
  } catch (error) {
    if (readonly) {
      setYRoomWriteBlocked(spaceId, documentId, previousWriteBlock);
    }
    throw error;
  }
}

/**
 * Read one document
 *
 * @tag Documents
 * @jobToken
 * @param documentId Document id or slug.
 * @query draft:boolean Read the current draft instead of the published revision. Requires editor permission.
 * @response #/components/schemas/DocumentResponse
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const rawSpaceId = requireParam(context.var.params, "spaceId");
    const rawId = requireParam(context.var.params, "documentId");
    const revParam = new URL(context.req.url).searchParams.get("rev");
    const draft = new URL(context.req.url).searchParams.get("draft") === "true";
    // live=true returns the draft content as currently held in the document's
    // collaboration room (if open), so partial edits reference the same state.
    const live = new URL(context.req.url).searchParams.get("live") === "true";

    const space = (await getSpace(rawSpaceId)) ?? (await getSpaceBySlug(rawSpaceId));
    if (!space) {
      throw notFoundResponse("Space");
    }
    const spaceId = space.id;
    const store = await openSpaceStore(spaceId);

    // Resolve slug → ID: try by ID first, fall back to slug so client-side
    // routing and cross-host callers can pass URL slugs directly.
    let id = rawId;
    const preCheck = await getDocument(store, rawId);
    if (!preCheck) {
      const bySlug = await getDocumentBySlug(store, rawId);
      if (bySlug) id = bySlug.id;
    }

    // Draft/live content is unpublished, so it requires editor; the published
    // view only requires viewer.
    const requiredRole = draft || live ? Permission.EDITOR : Permission.VIEWER;

    // `aclUserId` is carried past the gate for the revision guard: `null` is
    // the trusted system caller, `""` public. See verifyRevisionAccess.
    const { aclUserId } = await authenticateDocumentAccess(
      context.var.credentials,
      spaceId,
      id,
      requiredRole,
    );

    const meta = await getDocument(store, id);
    if (!meta) {
      throw notFoundResponse("Document");
    }
    // Hidden by any parameter, or `?rev=N` serves the body this refuses.
    if (meta.type === workflowRunDocumentType) {
      throw notFoundResponse("Document");
    }

    if (revParam) {
      const rev = parseQueryInt(new URL(context.req.url).searchParams, "rev", { min: 1 });

      // History, which the viewer gate above does not cover. Authorized before
      // the load, so a refusal cannot distinguish a missing revision.
      const access = await verifyRevisionAccess(spaceId, id, aclUserId, [rev]);

      const metadata = await getRevisionMetadata(store, id, rev);
      if (!metadata) {
        throw notFoundResponse("Revision");
      }

      const content = await getRevisionContent(store, id, rev);
      if (content === null) {
        throw notFoundResponse("Revision");
      }

      // A revision's bytes never change, so the tag comes from the revision
      // number. It still revalidates rather than sitting in a cache for an
      // hour: the body below varies with history access, and a grant can be
      // taken away under a response already stored.
      const revEtag = revisionEtag(rev);
      const revIfNoneMatch = context.req.raw.headers.get("if-none-match");
      if (revIfNoneMatch && matchesWeak(revIfNoneMatch, revEtag)) {
        return withCors(notModified(revEtag));
      }

      return withCors(
        jsonResponse(
          {
            // Without history access, the snapshot and nothing describing it.
            // `status` is stated rather than withheld: a published revision is by
            // definition not a suggestion, and clients branch on it.
            revision: access.metadata
              ? { ...metadata, content }
              : { rev: metadata.rev, content, status: null },
          },
          200,
          { ETag: revEtag, "Cache-Control": PRIVATE_REVALIDATE },
        ),
      );
    }

    // Only the canonical read is tagged. `?draft` and `?live` are different
    // representations of the same URL, and `?live` is not even a representation
    // of the stored row — it is whatever the collaboration room holds this
    // instant, which no column can describe. One tag across the three is how a
    // cache is talked into answering one with another.
    const etag = draft || live ? null : documentEtag(meta.changeSeq);
    const ifNoneMatch = context.req.raw.headers.get("if-none-match");
    if (etag && ifNoneMatch && matchesWeak(ifNoneMatch, etag)) {
      return withCors(notModified(etag, "Accept"));
    }

    // getDocument is metadata-only; this route returns the body, so load it
    // explicitly (from the live room when there is one, else the stored column).
    let document: DocumentMeta & { content: string };
    if (live) {
      document = {
        ...meta,
        content: getLiveDocumentContent(
          spaceId,
          id,
          meta.type,
          (await getDocumentContent(store, id)) ?? "",
        ),
      };
    } else if (!draft && meta.publishedRev !== null) {
      document = await resolvePublishedDocumentContent(store, {
        ...meta,
        content: (await getDocumentContent(store, id)) ?? "",
      });
    } else {
      document = {
        ...meta,
        content: (await getDocumentContent(store, id)) ?? "",
      };
    }

    const accept = context.req.raw.headers.get("Accept") ?? "";
    if (accept.includes("text/markdown") || accept.includes("text/plain")) {
      const serialized = isSerializedDocumentType(document.type);
      return withCors(
        new Response(
          serialized ? (document.content ?? "") : htmlToMarkdown(document.content ?? ""),
          {
            status: 200,
            headers: {
              "Content-Type": serialized
                ? "text/plain; charset=utf-8"
                : "text/markdown; charset=utf-8",
              // Same URL, same tag, a different body — so the tag is only
              // usable if a cache is told what the body was chosen by. Nothing
              // is added where there is no tag: an untagged representation
              // answers exactly as it did before.
              ...(etag
                ? { ETag: etag, Vary: "Accept", "Cache-Control": PRIVATE_REVALIDATE }
                : {}),
            },
          },
        ),
      );
    }

    const headerImageAspectRatio = await getUploadImageAspectRatio(
      spaceId,
      document.properties.headerImage,
    );

    return withCors(
      jsonResponse(
        {
          document: { ...document, headerImageAspectRatio },
          space: {
            id: space.id,
            slug: space.slug,
            name: space.name,
          },
        },
        200,
        etag
          ? { ETag: etag, Vary: "Accept", "Cache-Control": PRIVATE_REVALIDATE }
          : undefined,
      ),
    );
  }, "Failed to get document");

/**
 * Replace a document
 *
 * @tag Documents
 * @jobToken
 * @param documentId Document id or slug.
 * @body
 */
export const PUT: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");

    const store = await openSpaceStore(spaceId);
    const existingDoc = await getDocument(store, id);
    if (!existingDoc) {
      throw notFoundResponse("Document");
    }

    const publish = new URL(context.req.url).searchParams.get("publish") === "true";
    const expected = requestedCondition(context);
    let userId: string | undefined;

    const jobToken = context.req.raw.headers.get("X-Job-Token");
    if (jobToken) {
      const parsed = parseJobToken(jobToken, spaceId);
      if (!parsed) {
        throw unauthorizedResponse();
      }
      // Scope the token to the initiating user; user-less system tokens stay
      // trusted. Either way carry the id forward for authorship/restore.
      if (parsed.userId) {
        await verifyAccess(
          spaceId,
          { type: ResourceType.DOCUMENT, id: id },
          parsed.userId,
          Permission.EDITOR,
        );
      }
      userId = parsed.userId ?? undefined;
    } else {
      // Authenticate with either user session or access token
      const auth = await authenticateRequest(context.var.credentials, spaceId);
      if (auth.type === "token") {
        await verifyAccess(
          spaceId,
          { type: ResourceType.DOCUMENT, id: id },
          auth.token.tokenId,
          Permission.EDITOR,
        );
        userId = auth.token.tokenId;
      } else {
        await verifyAccess(
          spaceId,
          { type: ResourceType.DOCUMENT, id: id },
          auth.user.id,
          Permission.EDITOR,
        );
        userId = auth.user.id;
      }
    }

    const contentType = getMimeType(context.req.raw.headers.get("Content-Type"));
    let content: string;

    if (contentType === "application/json") {
      const body = await parseJsonBody(context.req.raw);
      const { content: jsonContent, restore } = body as {
        content?: unknown;
        restore?: unknown;
      };

      if (restore !== undefined) {
        if (typeof restore !== "boolean") {
          throw badRequestResponse("Restore must be a boolean");
        }

        if (!restore) {
          throw badRequestResponse("Restore must be true when provided");
        }

        if (jsonContent !== undefined) {
          throw badRequestResponse("Cannot combine restore with content update");
        }

        if (!userId) {
          throw forbiddenResponse("Invalid restore request");
        }

        const restored = await restoreDocument(store, id, userId, expected);
        if (!restored.ok) return conflictResponse(store, id);

        sendSyncEvent(
          spaceId,
          realtimeTopics.categoryDocuments,
          realtimeTopics.documentTree,
        );
        return jsonResponse({ success: true }, 200, {
          ETag: documentEtag(restored.changeSeq),
        });
      }

      if (documentIsReadonly(existingDoc)) {
        throw forbiddenResponse("Cannot update readonly document");
      }

      if (typeof jsonContent !== "string") {
        throw badRequestResponse("Content is required and must be a string");
      }

      content = isSerializedDocumentType(existingDoc.type)
        ? jsonContent
        : prepareDocumentContent(jsonContent, null);
    } else {
      if (documentIsReadonly(existingDoc)) {
        throw forbiddenResponse("Cannot update readonly document");
      }

      const rawContent = await context.req.raw.text();
      content = isSerializedDocumentType(existingDoc.type)
        ? rawContent
        : prepareDocumentContent(rawContent, contentType);
    }

    const written = await updateDocument(store, id, content, existingDoc.type, expected);
    if (!written.ok) {
      if (written.reason === "missing") throw notFoundResponse("Document");
      return conflictResponse(store, id);
    }
    let document = written.document;

    replaceLiveDocumentContent(spaceId, id, existingDoc.type, content);

    // Revisions are representation-agnostic snapshots. Collaborative draft
    // persistence remains revisionless; an explicit replacement does not.
    if (userId) {
      const revision = await createRevision(store, id, content, userId, {
        message: "Document updated",
      });
      if (publish === true) {
        await handlePublishedRevisionPatch(store, id, userId, revision.rev);
      }

      // updateDocument returned before the revision pointers changed. Return
      // their final canonical values so clients do not cache stale history.
      const savedDocument = await getDocument(store, id);
      if (!savedDocument) {
        throw notFoundResponse("Document");
      }
      document = savedDocument;
    }

    // Omit `content` from the response. Echoing the (potentially tens-of-MB)
    // document back doubles the serialization cost of every save and blocks the
    // event loop while `JSON.stringify` runs. The client already holds the
    // content it just sent, so it only needs the canonical metadata (revs,
    // timestamps) to reconcile its optimistic state.
    const { content: _omittedContent, ...documentMetadata } = document;
    // The tag the write produced, so a caller holding it can make its next
    // conditional write without reading the document back first — and, for a
    // syncing caller, without mistaking its own write for someone else's edit.
    return jsonResponse({ document: documentMetadata }, 200, {
      ETag: documentEtag(document.changeSeq),
    });
  }, "Failed to update document");

/**
 * Update parts of a document
 *
 * @tag Documents
 * @jobToken
 * @param documentId Document id or slug.
 * @body
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      const id = requireParam(context.var.params, "documentId");
      const store = await openSpaceStore(spaceId);
      const existingDoc = await getDocument(store, id);
      if (!existingDoc) {
        throw notFoundResponse("Document");
      }

      const auth = await authenticateJobTokenOrSpaceRole(
        context.var.credentials,
        spaceId,
        Permission.EDITOR,
        {
          type: ResourceType.DOCUMENT,
          id,
        },
      );
      const userId = auth.type === "user" ? auth.user.id : auth.userId;
      if (!userId) {
        throw forbiddenResponse("Job token is missing user context");
      }

      const body = parseDocumentPatchBody(await parseJsonBody<unknown>(context.req.raw));
      const { properties, parentId, publishedRev, readonly } = body;
      const expected = requestedCondition(context);

      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: id },
        userId,
        Permission.EDITOR,
      );

      if (properties !== undefined) {
        if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
          throw badRequestResponse("Properties must be an object");
        }

        const payload = await patchDocumentProperties(
          store,
          id,
          properties,
          userId,
          expected,
        );
        if (payload.conflict) return conflictResponse(store, id);

        // The body stays exactly what `successResponse(payload)` sent before:
        // the sequence travels in the header, where a caller that never asked
        // for it never sees it.
        const { changeSeq, conflict: _conflict, ...result } = payload;
        return jsonResponse(
          result,
          200,
          changeSeq === undefined ? undefined : { ETag: documentEtag(changeSeq) },
        );
      }

      // `parentId`, `publishedRev` and `readonly` each write through the
      // counter but take no condition of their own, so one check stands for the
      // three. It is a read-then-write and therefore racy in a way the property
      // path above is not — stated here rather than hidden, because the window
      // is a few milliseconds and these three are not what a syncing writer
      // contends over.
      if (expected && !expected.includes(existingDoc.changeSeq)) {
        return conflictResponse(store, id);
      }

      if (parentId !== undefined) {
        if (parentId !== null && typeof parentId !== "string") {
          throw badRequestResponse("Parent ID must be a string or null");
        }

        if (parentId) {
          // EDITOR on the parent, not read access: document ACLs inherit down
          // the tree, so this splices the document into grants it did not have.
          await verifyAccess(
            spaceId,
            { type: ResourceType.DOCUMENT, id: parentId },
            userId,
            Permission.EDITOR,
          );
        }

        const parentChange = await setDocumentParent(store, id, parentId).catch(
          (error) => {
            if (error instanceof InvalidDocumentParentError) {
              throw badRequestResponse(error.message);
            }
            throw error;
          },
        );
        const parentChangeData = {
          kind: "document_parent_changed",
          documentId: id,
          previousParentId: parentChange.previousParentId,
          parentId: parentChange.parentId,
        };

        sendSyncEvent(
          spaceId,
          {
            topic: realtimeTopics.documentTree,
            data: parentChangeData,
          },
          {
            topic: realtimeTopics.categoryDocuments,
            data: parentChangeData,
          },
          {
            topic: realtimeTopics.document(id),
            data: parentChangeData,
          },
        );
      }

      if (publishedRev !== undefined) {
        if (publishedRev !== null && typeof publishedRev !== "number") {
          throw badRequestResponse("Published revision must be a number or null");
        }

        await handlePublishedRevisionPatch(store, id, userId, publishedRev);
      }

      if (readonly !== undefined) {
        await handleReadonlyPatch(store, id, userId, readonly);
      }

      const patched = await getDocument(store, id);
      return jsonResponse(
        { success: true },
        200,
        patched ? { ETag: documentEtag(patched.changeSeq) } : undefined,
      );
    },
    {
      fallbackMessage: "Failed to patch document",
      onError(error) {
        if (
          error instanceof InvalidDocumentPropertyPatchError ||
          error instanceof ReservedDocumentPropertyKeyError
        ) {
          return badRequestResponse(error.message);
        }
      },
    },
  );

/**
 * Archive or delete a document
 *
 * @tag Documents
 * @jobToken
 * @param documentId Document id or slug.
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");
    const permanent = new URL(context.req.url).searchParams.get("permanent") === "true";
    const auth = await authenticateJobTokenOrSpaceRole(
      context.var.credentials,
      spaceId,
      Permission.EDITOR,
      {
        type: ResourceType.DOCUMENT,
        id,
      },
    );
    const userId = auth.type === "user" ? auth.user.id : auth.userId;
    if (!userId) {
      throw forbiddenResponse("Job token is missing user context");
    }

    const store = await openSpaceStore(spaceId);
    const expected = requestedCondition(context);
    // A condition on a document that is not there is not a failed condition:
    // there is no resource to have a state, so the answer is the same 404 a
    // plain request would get.
    if (expected && !(await getDocument(store, id))) {
      throw notFoundResponse("Document");
    }

    if (permanent) {
      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: id },
        userId,
        Permission.OWNER,
      );
      if (!(await deleteDocument(store, id, userId, expected))) {
        return conflictResponse(store, id);
      }
    } else {
      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: id },
        userId,
        Permission.EDITOR,
      );
      const archived = await archiveDocument(store, id, userId, expected);
      if (!archived.ok) return conflictResponse(store, id);
    }

    return successResponse();
  }, "Failed to delete document");

/**
 * Authorize a write to a document's revision history. A full revision is a
 * document write like any other here, so `EDITOR`; a suggestion changes nothing
 * until an editor applies it, so it takes `Feature.COMMENT` instead (audit 014).
 */
async function verifyRevisionWrite(
  spaceId: string,
  documentId: string,
  userId: string,
  mode: "revision" | "suggestion",
): Promise<void> {
  if (mode === "suggestion") {
    // Scoped to the document, or a document-scoped editor would be refused the
    // weaker action while the full save below succeeds.
    await verifyFeatureAccess(spaceId, Feature.COMMENT, userId, documentId);
    return;
  }

  await verifyAccess(
    spaceId,
    { type: ResourceType.DOCUMENT, id: documentId },
    userId,
    Permission.EDITOR,
  );
}

/**
 * Publish the document's current draft
 *
 * @tag Documents
 * @jobToken
 * @param documentId Document id or slug.
 * @body?
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    // Not redundant with the suggestion gate below: COMMENT is granted per
    // space, so this is what confines a suggester to documents they can read.
    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: documentId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const document = await getDocument(store, documentId);
    if (!document) {
      throw badRequestResponse("Document not found");
    }

    if (documentIsReadonly(document)) {
      throw forbiddenResponse("Cannot save readonly document");
    }

    const contentType = getMimeType(context.req.raw.headers.get("Content-Type"));
    const isJson = contentType === "application/json";
    // A non-JSON body carries content and nothing else, so it can only ever be
    // a full revision.
    const body = isJson
      ? await parseJsonBody<{
          html?: unknown;
          contentType?: unknown;
          message?: unknown;
          mode?: unknown;
        }>(context.req.raw)
      : { mode: "revision" as const };

    // `null` and scalars parse as valid JSON, and reading `mode` off them throws
    // a 500 on what is a malformed request.
    if (typeof body !== "object" || body === null) {
      throw badRequestResponse("JSON body must be an object");
    }

    if (
      body.mode !== undefined &&
      body.mode !== "revision" &&
      body.mode !== "suggestion"
    ) {
      throw badRequestResponse('Mode must be "revision" or "suggestion"');
    }
    const mode = body.mode ?? "revision";

    // Before the content is validated, so a refused caller gets that verdict
    // rather than a critique of their payload. Only `mode` is read first.
    await verifyRevisionWrite(spaceId, documentId, user.id, mode);

    let revisionContent: string;
    let message: string | undefined;

    if (isJson) {
      if (!body.html || typeof body.html !== "string") {
        throw badRequestResponse("Revision content is required and must be a string");
      }

      if (body.contentType !== undefined && typeof body.contentType !== "string") {
        throw badRequestResponse("Content type must be a string");
      }
      revisionContent = isSerializedDocumentType(document.type)
        ? body.html
        : prepareDocumentContent(
            body.html,
            typeof body.contentType === "string" ? body.contentType : "text/html",
          );
      message = typeof body.message === "string" ? body.message : undefined;
    } else {
      const rawContent = await context.req.raw.text();
      if (!rawContent) {
        throw badRequestResponse("Content is required and must be a string");
      }

      revisionContent = isSerializedDocumentType(document.type)
        ? rawContent
        : prepareDocumentContent(rawContent, contentType);
    }

    const revision =
      mode === "suggestion"
        ? await createSuggestion(store, documentId, revisionContent, user.id, message)
        : await createRevision(store, documentId, revisionContent, user.id, {
            message,
          });

    if (!revision) {
      // Only createSuggestion answers null: no revision to base one on, or the
      // document went away since the check above.
      throw badRequestResponse(
        "Cannot suggest changes to a document with no saved revision",
      );
    }

    return jsonResponse({
      revision: {
        id: revision.id,
        documentId: revision.documentId,
        rev: revision.rev,
        checksum: revision.checksum,
        parentRev: revision.parentRev,
        status: revision.status,
        message: revision.message,
        createdAt: revision.createdAt,
        createdBy: revision.createdBy,
      },
    });
  }, "Failed to create revision");
