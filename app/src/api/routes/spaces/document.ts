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
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getSpaceDb } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { document as documentTable } from "#db/schema/space.ts";
import { createAuditLog } from "#db/space/auditLogs.ts";
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
import { patchDocumentProperties } from "#db/space/properties.ts";
import {
  createRevision,
  createSuggestion,
  getRevisionContent,
  getRevisionMetadata,
  resolvePublishedDocumentContent,
} from "#db/space/revisions.ts";
import { getSpace, getSpaceBySlug } from "#db/space/spaces.ts";
import { getMimeType, toHtmlIfMarkdown } from "#documents/content.ts";
import {
  type DocumentPropertyPatch,
  InvalidDocumentPropertyPatchError,
  ReservedDocumentPropertyKeyError,
} from "#documents/properties.ts";
import {
  contentIsHtml,
  documentIsReadonly,
  readOnlyDocumentTypes,
  workflowRunDocumentType,
} from "#documents/types.ts";
import { getUploadImageAspectRatio } from "#files/imageDimensions.ts";
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
import { sanitizeDocumentHtml } from "#utils/html.ts";
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

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handlePublishedRevisionPatch(
  spaceId: string,
  documentId: string,
  userId: string,
  publishedRev: number | null,
) {
  const revToPublish = publishedRev === null ? null : publishedRev;

  const db = await getSpaceDb(spaceId);
  const existing = await one(
    db
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
      : await getRevisionContent(await openSpaceStore(spaceId), documentId, revToPublish);
  if (revToPublish !== null && !revisionContent) {
    throw notFoundResponse("Revision");
  }

  await db
    .update(documentTable)
    .set({ publishedRev: revToPublish })
    .where(eq(documentTable.id, documentId));

  const auditEntry = await createAuditLog(await openSpaceStore(spaceId), {
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

  if (revToPublish === null) {
    return;
  }

  if (!revisionContent) throw notFoundResponse("Revision");

  // Publishing a revision also loads it into the draft, so the editor (which
  // always reads doc.content) reflects the revision that is now published.
  await db
    .update(documentTable)
    .set({ content: revisionContent })
    .where(eq(documentTable.id, documentId));

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
      publishedHtml: revisionContent,
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
  spaceId: string,
  documentId: string,
  userId: string,
  readonly: boolean,
) {
  if (typeof readonly !== "boolean") {
    throw badRequestResponse("Readonly must be a boolean");
  }

  const previousWriteBlock = readonly
    ? setYRoomWriteBlocked(spaceId, documentId, true)
    : false;

  try {
    if (readonly) await persistYRoomDraft(roomKey(spaceId, documentId));

    const store = await openSpaceStore(spaceId);
    await store.tx(async (tx) => {
      await tx.db
        .update(documentTable)
        .set({ readonly })
        .where(eq(documentTable.id, documentId));

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

    // Resolve slug → ID: try by ID first, fall back to slug so client-side
    // routing and cross-host callers can pass URL slugs directly.
    let id = rawId;
    const preCheck = await getDocument(await openSpaceStore(spaceId), rawId);
    if (!preCheck) {
      const bySlug = await getDocumentBySlug(await openSpaceStore(spaceId), rawId);
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

    const meta = await getDocument(await openSpaceStore(spaceId), id);
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

      const metadata = await getRevisionMetadata(await openSpaceStore(spaceId), id, rev);
      if (!metadata) {
        throw notFoundResponse("Revision");
      }

      const content = await getRevisionContent(await openSpaceStore(spaceId), id, rev);
      if (!content) {
        throw notFoundResponse("Revision");
      }

      return withCors(
        jsonResponse({
          // Without history access, the snapshot and nothing describing it.
          // `status` is stated rather than withheld: a published revision is by
          // definition not a suggestion, and clients branch on it.
          revision: access.metadata
            ? { ...metadata, content }
            : { rev: metadata.rev, content, status: null },
        }),
      );
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
          (await getDocumentContent(await openSpaceStore(spaceId), id)) ?? "",
        ),
      };
    } else if (!draft && meta.publishedRev !== null) {
      document = await resolvePublishedDocumentContent(await openSpaceStore(spaceId), {
        ...meta,
        content: (await getDocumentContent(await openSpaceStore(spaceId), id)) ?? "",
      });
    } else {
      document = {
        ...meta,
        content: (await getDocumentContent(await openSpaceStore(spaceId), id)) ?? "",
      };
    }

    const accept = context.req.raw.headers.get("Accept") ?? "";
    if (accept.includes("text/markdown") || accept.includes("text/plain")) {
      return withCors(
        new Response(htmlToMarkdown(document.content ?? ""), {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        }),
      );
    }

    const headerImageAspectRatio = await getUploadImageAspectRatio(
      spaceId,
      document.properties.headerImage,
    );

    return withCors(
      jsonResponse({
        document: { ...document, headerImageAspectRatio },
        space: {
          id: space.id,
          slug: space.slug,
          name: space.name,
        },
      }),
    );
  }, "Failed to get document");

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
    let nextType: string | null | undefined;

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

        await restoreDocument(store, id, userId);
        sendSyncEvent(
          spaceId,
          realtimeTopics.categoryDocuments,
          realtimeTopics.documentTree,
        );
        return jsonResponse({ success: true });
      }

      if (documentIsReadonly(existingDoc)) {
        throw forbiddenResponse("Cannot update readonly document");
      }

      if (!jsonContent || typeof jsonContent !== "string") {
        throw badRequestResponse("Content is required and must be a string");
      }

      // Only the request's own content type may say the body needs converting.
      // The document's type must not: a csv document's content *is* the table,
      // so passing it here would run the stored markup through the CSV
      // converter again and bury the whole document in one escaped cell.
      content = toHtmlIfMarkdown(jsonContent, contentType);
      nextType = existingDoc.type;
    } else {
      if (documentIsReadonly(existingDoc)) {
        throw forbiddenResponse("Cannot update readonly document");
      }

      const rawContent = await context.req.raw.text();
      if (!rawContent) {
        throw badRequestResponse("Content is required and must be a string");
      }

      nextType = existingDoc.type;
      // As above: the body is described by `contentType` alone. Re-uploading a
      // `text/csv` body over a csv document still converts, which is the case
      // the document type was standing in for.
      content = toHtmlIfMarkdown(rawContent, contentType);
    }

    // Canvas/app documents store serialized JSON, not HTML — parsing it as
    // markup is meaningless and, on tens-of-MB canvases, an expensive
    // event-loop-blocking scan, so skip it for non-HTML types.
    const contentSanitized = contentIsHtml(nextType)
      ? sanitizeDocumentHtml(content)
      : content;

    // createRevision records the canonical content-save audit event, including
    // its revision ID. Do not also record the draft write or the activity feed
    // shows a duplicate edit without revision actions.
    let document = await updateDocument(store, id, contentSanitized, nextType);
    if (!document) {
      throw notFoundResponse("Document");
    }

    replaceLiveDocumentContent(spaceId, id, nextType, contentSanitized);

    if (userId) {
      const revision = await createRevision(store, id, contentSanitized, userId, {
        message: "Document updated",
      });
      if (publish === true) {
        await handlePublishedRevisionPatch(spaceId, id, userId, revision.rev);
        // updateDocument returns before the newly-created revision is assigned
        // to publishedRev. Return the final canonical document so clients can
        // replace their optimistic publish state with the real revision number.
        const publishedDocument = await getDocument(store, id);
        if (!publishedDocument) {
          throw notFoundResponse("Document");
        }
        document = publishedDocument;
      }
    }

    // Omit `content` from the response. Echoing the (potentially tens-of-MB)
    // document back doubles the serialization cost of every save and blocks the
    // event loop while `JSON.stringify` runs. The client already holds the
    // content it just sent, so it only needs the canonical metadata (revs,
    // timestamps) to reconcile its optimistic state.
    const { content: _omittedContent, ...documentMetadata } = document;
    return jsonResponse({ document: documentMetadata });
  }, "Failed to update document");

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

        const payload = await patchDocumentProperties(store, id, properties, userId);
        return successResponse(payload);
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

        await handlePublishedRevisionPatch(spaceId, id, userId, publishedRev);
      }

      if (readonly !== undefined) {
        if (readOnlyDocumentTypes.includes(existingDoc.type ?? "") && readonly !== true) {
          throw badRequestResponse(
            `Documents of type "${existingDoc.type}" are readonly`,
          );
        }
        await handleReadonlyPatch(spaceId, id, userId, readonly);
      }

      return jsonResponse({ success: true });
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
    if (permanent) {
      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: id },
        userId,
        Permission.OWNER,
      );
      await deleteDocument(store, id, userId);
    } else {
      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: id },
        userId,
        Permission.EDITOR,
      );
      await archiveDocument(store, id, userId);
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
      ? await parseJsonBody<{ html?: unknown; message?: unknown; mode?: unknown }>(
          context.req.raw,
        )
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

    let html: string;
    let message: string | undefined;

    if (isJson) {
      if (!body.html || typeof body.html !== "string") {
        throw badRequestResponse("HTML content is required and must be a string");
      }

      html = toHtmlIfMarkdown(body.html, contentType, document.type);
      message = typeof body.message === "string" ? body.message : undefined;
    } else {
      const rawContent = await context.req.raw.text();
      if (!rawContent) {
        throw badRequestResponse("Content is required and must be a string");
      }

      html = toHtmlIfMarkdown(rawContent, contentType, document.type);
    }

    const revision =
      mode === "suggestion"
        ? await createSuggestion(store, documentId, html, user.id, message)
        : await createRevision(store, documentId, html, user.id, { message });

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
