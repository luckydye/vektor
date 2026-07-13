import type { ApiRouteHandler } from "#api/server/types.ts";
import { eq } from "drizzle-orm";
import { getTokenUserId } from "#db/accessTokens.ts";
import { ResourceType } from "#db/acl.ts";
import {
  authenticateRequest,
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  parseQueryInt,
  requireParam,
  requireUser,
  successResponse,
  tryAuthenticateRequest,
  unauthorizedResponse,
  verifyDocumentAccess,
  verifyDocumentRole,
  verifyTokenPermission,
  withApiErrorHandling,
} from "#db/api.ts";
import { createAuditLog } from "#db/auditLogs.ts";
import { getSpaceDb } from "#db/db.ts";
import {
  archiveDocument,
  deleteDocument,
  deleteDocumentProperty,
  getDocument,
  getDocumentBySlug,
  restoreDocument,
  setDocumentParent,
  updateDocument,
  updateDocumentProperty,
} from "#db/documents.ts";
import {
  createRevision,
  createSuggestion,
  getPublishedContent,
  getRevisionContent,
  getRevisionMetadata,
} from "#db/revisions.ts";
import { document as documentTable } from "#db/schema/space.ts";
import { getSpace, getSpaceBySlug } from "#db/spaces.ts";
import { sendSyncEvent } from "#db/ws.ts";
import { getHeaderImageAspectRatio } from "#files/headerImageAspect.ts";
import { parseJobToken } from "#jobs/jobToken.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";
import { getMimeType, toHtmlIfMarkdown } from "#utils/documentContent.ts";
import { htmlToMarkdown } from "#utils/documentMarkdown.ts";
import { readOnlyDocumentTypes } from "#utils/documentTypes.ts";
import { realtimeTopics } from "#utils/realtime.ts";
import { stripScriptTags } from "#utils/utils.ts";
import { getLiveDocumentContent } from "#utils/yjsRooms.ts";

type PropertyPatchValue =
  | null
  | string
  | string[]
  | number
  | boolean
  | Array<string | number | boolean | null>
  | {
      value: unknown;
      type?: string | null;
    };

type DocumentPatchBody = {
  properties?: Record<string, PropertyPatchValue>;
  parentId?: string | null;
  publishedRev?: number | null;
  readonly?: boolean;
};

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

async function handlePropertiesPatch(
  spaceId: string,
  documentId: string,
  userId: string,
  properties: Record<string, PropertyPatchValue>,
) {
  const propertyEntries = Object.entries(properties);
  const payload: { slug?: string } = {};

  for (const [propertyKey, propertyPatch] of propertyEntries) {
    if (!propertyKey || typeof propertyKey !== "string") {
      throw badRequestResponse("Property key is required and must be a non-empty string");
    }

    if (propertyPatch === null) {
      await deleteDocumentProperty(spaceId, documentId, propertyKey, userId);
      continue;
    }

    let nextValue: unknown = propertyPatch;
    let nextType: string | null | undefined;

    if (
      typeof propertyPatch === "object" &&
      propertyPatch !== null &&
      !Array.isArray(propertyPatch)
    ) {
      if (!("value" in propertyPatch)) {
        throw badRequestResponse(
          `Property "${propertyKey}" object payload must include "value"`,
        );
      }

      nextValue = propertyPatch.value;
      nextType = propertyPatch.type;

      if (nextType !== undefined && nextType !== null && typeof nextType !== "string") {
        throw badRequestResponse(
          `Property "${propertyKey}" type must be a string, null, or undefined`,
        );
      }
    }

    // TODO: slug changes should happen with a document save, not property update
    const changedProperties = await updateDocumentProperty(
      spaceId,
      documentId,
      propertyKey,
      Array.isArray(nextValue)
        ? nextValue
            .filter((value) => value !== null && value !== undefined)
            .map((value) => String(value))
        : String(nextValue),
      nextType,
      userId,
    );

    if (changedProperties.slug) {
      payload.slug = changedProperties.slug;
    }
  }

  return payload;
}

async function handlePublishedRevisionPatch(
  spaceId: string,
  documentId: string,
  userId: string,
  publishedRev: number | null,
) {
  const revToPublish = publishedRev === null ? null : publishedRev;

  const db = await getSpaceDb(spaceId);
  await db
    .update(documentTable)
    .set({ publishedRev: revToPublish })
    .where(eq(documentTable.id, documentId));

  await createAuditLog(db, {
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

  const revisionContent = await getRevisionContent(spaceId, documentId, revToPublish);
  if (!revisionContent || revisionContent === null) {
    throw notFoundResponse("Revision");
  }

  // Publishing a revision also loads it into the draft, so the editor (which
  // always reads doc.content) reflects the revision that is now published.
  await db
    .update(documentTable)
    .set({ content: revisionContent })
    .where(eq(documentTable.id, documentId));
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

  const db = await getSpaceDb(spaceId);
  await db
    .update(documentTable)
    .set({ readonly: readonly })
    .where(eq(documentTable.id, documentId));

  await createAuditLog(db, {
    spaceId,
    docId: documentId,
    userId,
    event: readonly ? "lock" : "unlock",
    details: {
      message: readonly ? "Document set to readonly" : "Document readonly removed",
    },
  });
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
    const preCheck = await getDocument(spaceId, rawId);
    if (!preCheck) {
      const bySlug = await getDocumentBySlug(spaceId, rawId);
      if (bySlug) id = bySlug.id;
    }

    // Draft/live content is unpublished, so it requires editor; the published
    // view only requires viewer.
    const requiredRole = draft || live ? "editor" : "viewer";

    const jobToken = context.req.raw.headers.get("X-Job-Token");
    if (jobToken) {
      const parsed = parseJobToken(jobToken, spaceId);
      if (!parsed) {
        throw unauthorizedResponse();
      }
      // Scope the token to the user who initiated it; only user-less system
      // tokens read without a per-document check.
      if (parsed.userId) {
        await verifyDocumentRole(spaceId, id, parsed.userId, requiredRole);
      }
    } else {
      // Authenticate with either user session or access token
      const auth = await tryAuthenticateRequest(context, spaceId);
      if (auth?.type === "token") {
        await verifyTokenPermission(
          auth.token,
          spaceId,
          ResourceType.DOCUMENT,
          id,
          requiredRole,
        );
      } else if (auth?.type === "user") {
        await verifyDocumentRole(spaceId, id, auth.user.id, requiredRole);
      } else {
        // Unauthenticated — verifyDocumentRole handles public access
        await verifyDocumentRole(spaceId, id, null, requiredRole);
      }
    }

    if (revParam) {
      const rev = parseQueryInt(new URL(context.req.url).searchParams, "rev", { min: 1 });

      const metadata = await getRevisionMetadata(spaceId, id, rev);
      if (!metadata) {
        throw notFoundResponse("Revision");
      }

      const content = await getRevisionContent(spaceId, id, rev);
      if (!content) {
        throw notFoundResponse("Revision");
      }

      return withCors(
        jsonResponse({
          revision: {
            ...metadata,
            content,
          },
        }),
      );
    }

    let document = await getDocument(spaceId, id);
    if (!document) {
      throw notFoundResponse("Document");
    }

    if (live) {
      document = {
        ...document,
        content: getLiveDocumentContent(
          spaceId,
          id,
          document.type,
          document.content ?? "",
        ),
      };
    } else if (!draft && document.publishedRev !== null) {
      const publishedContent = await getPublishedContent(spaceId, id);
      if (publishedContent) {
        document = {
          ...document,
          content: publishedContent,
        };
      }
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

    const headerImageAspectRatio = await getHeaderImageAspectRatio(
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

    const existingDoc = await getDocument(spaceId, id);
    if (!existingDoc) {
      throw notFoundResponse("Document");
    }

    const publish = new URL(context.req.url).searchParams.get("publish") === "true";
    let userId: string | undefined;

    const jobToken = context.req.raw.headers.get("X-Job-Token");
    const isJobRequest = Boolean(jobToken);
    if (jobToken) {
      const parsed = parseJobToken(jobToken, spaceId);
      if (!parsed) {
        throw unauthorizedResponse();
      }
      // Scope the token to the initiating user; user-less system tokens stay
      // trusted. Either way carry the id forward for authorship/restore.
      if (parsed.userId) {
        await verifyDocumentRole(spaceId, id, parsed.userId, "editor");
      }
      userId = parsed.userId ?? undefined;
    } else {
      // Authenticate with either user session or access token
      const auth = await authenticateRequest(context, spaceId);
      if (auth.type === "token") {
        await verifyTokenPermission(
          auth.token,
          spaceId,
          ResourceType.DOCUMENT,
          id,
          "editor",
        );
        userId = getTokenUserId(auth.token.tokenId);
      } else {
        await verifyDocumentRole(spaceId, id, auth.user.id, "editor");
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

        await restoreDocument(spaceId, id, userId);
        sendSyncEvent(
          spaceId,
          realtimeTopics.categoryDocuments,
          realtimeTopics.documentTree,
        );
        return jsonResponse({ success: true });
      }

      if (
        !isJobRequest &&
        (existingDoc.readonly || readOnlyDocumentTypes.includes(existingDoc.type ?? ""))
      ) {
        throw forbiddenResponse("Cannot update readonly document");
      }

      if (!jsonContent || typeof jsonContent !== "string") {
        throw badRequestResponse("Content is required and must be a string");
      }

      content = toHtmlIfMarkdown(jsonContent, contentType, existingDoc.type);
      nextType = existingDoc.type;
    } else {
      if (
        !isJobRequest &&
        (existingDoc.readonly || readOnlyDocumentTypes.includes(existingDoc.type ?? ""))
      ) {
        throw forbiddenResponse("Cannot update readonly document");
      }

      const rawContent = await context.req.raw.text();
      if (!rawContent) {
        throw badRequestResponse("Content is required and must be a string");
      }

      nextType = existingDoc.type;
      content = toHtmlIfMarkdown(rawContent, contentType, nextType);
    }

    // TODO: propper sanitization needed, parse html doc and only use allowed elements and attributes.
    const contentSanitized = stripScriptTags(content);

    let document = await updateDocument(spaceId, id, contentSanitized, userId, nextType);

    if (userId) {
      const revision = await createRevision(spaceId, id, contentSanitized, userId, {
        message: "Document updated",
      });
      if (publish === true) {
        await handlePublishedRevisionPatch(spaceId, id, userId, revision.rev);
        // updateDocument returns before the newly-created revision is assigned
        // to publishedRev. Return the final canonical document so clients can
        // replace their optimistic publish state with the real revision number.
        const publishedDocument = await getDocument(spaceId, id);
        if (!publishedDocument) {
          throw notFoundResponse("Document");
        }
        document = publishedDocument;
      }
    }

    return jsonResponse({ document });
  }, "Failed to update document");

export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");
    const existingDoc = await getDocument(spaceId, id);
    if (!existingDoc) {
      throw notFoundResponse("Document");
    }

    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor", {
      type: ResourceType.DOCUMENT,
      id,
    });
    const userId = auth.type === "user" ? auth.user.id : auth.userId;
    if (!userId) {
      throw forbiddenResponse("Job token is missing user context");
    }

    const body = await parseJsonBody<DocumentPatchBody>(context.req.raw);
    const { properties, parentId, publishedRev, readonly } = body;

    await verifyDocumentRole(spaceId, id, userId, "editor");

    if (properties !== undefined) {
      if (
        parentId !== undefined ||
        publishedRev !== undefined ||
        readonly !== undefined
      ) {
        throw badRequestResponse(
          "Properties patch cannot be combined with parentId, publishedRev, or readonly",
        );
      }

      if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
        throw badRequestResponse("Properties must be an object");
      }

      const payload = await handlePropertiesPatch(
        spaceId,
        id,
        userId,
        properties as Record<string, PropertyPatchValue>,
      );
      return successResponse(payload);
    }

    if (parentId !== undefined) {
      if (parentId !== null && typeof parentId !== "string") {
        throw badRequestResponse("Parent ID must be a string or null");
      }

      if (parentId) {
        await verifyDocumentAccess(spaceId, parentId, userId);
      }

      const parentChange = await setDocumentParent(spaceId, id, parentId);
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
        throw badRequestResponse("CSV documents are readonly");
      }
      await handleReadonlyPatch(spaceId, id, userId, readonly);
    }

    return jsonResponse({ success: true });
  }, "Failed to patch document");

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const id = requireParam(context.var.params, "documentId");
    const permanent = new URL(context.req.url).searchParams.get("permanent") === "true";
    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor", {
      type: ResourceType.DOCUMENT,
      id,
    });
    const userId = auth.type === "user" ? auth.user.id : auth.userId;
    if (!userId) {
      throw forbiddenResponse("Job token is missing user context");
    }

    if (permanent) {
      await verifyDocumentRole(spaceId, id, userId, "owner");
      await deleteDocument(spaceId, id, userId);
    } else {
      await verifyDocumentRole(spaceId, id, userId, "editor");
      await archiveDocument(spaceId, id, userId);
    }

    return successResponse();
  }, "Failed to delete document");

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");

    await verifyDocumentAccess(spaceId, documentId, user.id);

    const document = await getDocument(spaceId, documentId);
    if (!document) {
      throw badRequestResponse("Document not found");
    }

    if (document.readonly || readOnlyDocumentTypes.includes(document.type ?? "")) {
      throw forbiddenResponse("Cannot save readonly document");
    }

    const contentType = getMimeType(context.req.raw.headers.get("Content-Type"));
    let html: string;
    let message: string | undefined;

    if (contentType === "application/json") {
      const body = await parseJsonBody(context.req.raw);
      const { html: jsonHtml, message: jsonMessage, mode } = body;

      if (!jsonHtml || typeof jsonHtml !== "string") {
        throw badRequestResponse("HTML content is required and must be a string");
      }

      if (mode !== undefined && mode !== "revision" && mode !== "suggestion") {
        throw badRequestResponse('Mode must be "revision" or "suggestion"');
      }

      html = toHtmlIfMarkdown(jsonHtml, contentType, document.type);
      message = typeof jsonMessage === "string" ? jsonMessage : undefined;

      const revision =
        mode === "suggestion"
          ? await createSuggestion(spaceId, documentId, html, user.id, message)
          : await createRevision(spaceId, documentId, html, user.id, {
              message,
            });

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
    } else {
      const rawContent = await context.req.raw.text();
      if (!rawContent) {
        throw badRequestResponse("Content is required and must be a string");
      }

      html = toHtmlIfMarkdown(rawContent, contentType, document.type);
    }

    const revision = await createRevision(spaceId, documentId, html, user.id, {
      message,
    });

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
