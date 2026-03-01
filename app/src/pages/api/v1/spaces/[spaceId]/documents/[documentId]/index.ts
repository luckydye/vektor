import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  forbiddenResponse,
  notFoundResponse,
  parseJsonBody,
  parseQueryInt,
  requireParam,
  requireUser,
  successResponse,
  verifyDocumentAccess,
  verifyDocumentRole,
  authenticateRequest,
  verifyTokenPermission,
  withApiErrorHandling,
} from "#db/api.ts";
import { verifyJobToken } from "../../../../../../../jobs/jobToken.ts";
import { ResourceType } from "#db/acl.ts";
import { getTokenUserId } from "#db/accessTokens.ts";
import {
  archiveDocument,
  deleteDocument,
  deleteDocumentProperty,
  getDocument,
  restoreDocument,
  setDocumentParent,
  updateDocumentProperty,
  updateDocument,
} from "#db/documents.ts";
import { triggerWebhooks } from "#db/webhooks.ts";
import { stripScriptTags } from "../../../../../../../utils/utils.ts";
import {
  getPublishedContent,
  getRevisionContent,
  getRevisionMetadata,
} from "#db/revisions.ts";
import { createRevision } from "#db/revisions.ts";
import { getUniqueMentionedEmails } from "#db/mentions.ts";
import { sendSyncEvent } from "~/src/db/ws.ts";
import {
  getMimeType,
  toHtmlIfMarkdown,
} from "../../../../../../../utils/documentContent.ts";
import { getSpaceDb } from "#db/db.ts";
import { document as documentTable } from "#db/schema/space.ts";
import { eq } from "drizzle-orm";
import { createAuditLog } from "#db/auditLogs.ts";

type PropertyPatchValue =
  | null
  | string
  | number
  | boolean
  | {
      value: unknown;
      type?: string | null;
    };

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
      String(nextValue),
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
  if (publishedRev !== null) {
    if (
      typeof publishedRev !== "number" ||
      !Number.isInteger(publishedRev) ||
      publishedRev < 1
    ) {
      throw badRequestResponse("Published revision must be null or a positive integer");
    }
  }

  const db = await getSpaceDb(spaceId);
  await db
    .update(documentTable)
    .set({ publishedRev: publishedRev })
    .where(eq(documentTable.id, documentId));

  await createAuditLog(db, {
    docId: documentId,
    revisionId: publishedRev || undefined,
    userId,
    event: publishedRev === null ? "unpublish" : "publish",
    details: {
      message:
        publishedRev === null
          ? "Document unpublished"
          : `Published revision ${publishedRev}`,
    },
  });

  await triggerWebhooks(db, {
    event: publishedRev === null ? "document.unpublished" : "document.published",
    spaceId,
    documentId,
    revisionId: publishedRev || undefined,
    timestamp: new Date().toISOString(),
  });

  const revisionContent = await getRevisionContent(spaceId, documentId, publishedRev);
  if (!revisionContent) {
    return;
  }

  const mentionedEmails = getUniqueMentionedEmails(revisionContent);
  if (mentionedEmails.length === 0) {
    return;
  }

  for (const email of mentionedEmails) {
    await triggerWebhooks(db, {
      event: "mention",
      spaceId,
      documentId,
      revisionId: publishedRev,
      timestamp: new Date().toISOString(),
      data: {
        mentionedUser: email,
        mentionedBy: userId,
      },
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

  const db = await getSpaceDb(spaceId);
  await db
    .update(documentTable)
    .set({ readonly: readonly })
    .where(eq(documentTable.id, documentId));

  await createAuditLog(db, {
    docId: documentId,
    userId,
    event: readonly ? "lock" : "unlock",
    details: {
      message: readonly ? "Document set to readonly" : "Document readonly removed",
    },
  });
}

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "documentId");
    const revParam = context.url.searchParams.get("rev");

    const jobToken = context.request.headers.get("X-Job-Token");
    if (jobToken) {
      if (!verifyJobToken(jobToken, spaceId))
        throw forbiddenResponse("Invalid job token");
    } else {
      // Authenticate with either user session or access token
      const auth = await authenticateRequest(context, spaceId);
      if (auth.type === "token") {
        await verifyTokenPermission(
          auth.token,
          spaceId,
          ResourceType.DOCUMENT,
          id,
          "viewer",
        );
      } else {
        await verifyDocumentRole(spaceId, id, auth.user.id, "viewer");
      }
    }

    if (revParam) {
      const rev = parseQueryInt(context.url.searchParams, "rev", { min: 1 });

      const metadata = await getRevisionMetadata(spaceId, id, rev);
      if (!metadata) {
        throw notFoundResponse("Revision");
      }

      const content = await getRevisionContent(spaceId, id, rev);
      if (!content) {
        throw notFoundResponse("Revision");
      }

      return jsonResponse({
        revision: {
          ...metadata,
          content,
        },
      });
    }

    let document = await getDocument(spaceId, id);
    if (!document) {
      throw notFoundResponse("Document");
    }

    if (document.publishedRev !== null) {
      const publishedContent = await getPublishedContent(spaceId, id);
      if (publishedContent) {
        document = {
          ...document,
          content: publishedContent,
        };
      }
    }

    return jsonResponse({ document });
  }, "Failed to get document");

export const PUT: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "documentId");

    const existingDoc = await getDocument(spaceId, id);
    if (!existingDoc) {
      throw notFoundResponse("Document");
    }

    let userId: string | undefined;

    const jobToken = context.request.headers.get("X-Job-Token");
    if (jobToken) {
      if (!verifyJobToken(jobToken, spaceId)) {
        throw forbiddenResponse("Invalid job token");
      }
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

    const contentType = getMimeType(context.request.headers.get("Content-Type"));
    let content: string;

    if (contentType === "application/json") {
      const body = await parseJsonBody(context.request);
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
        sendSyncEvent("wiki_category_documents");
        return jsonResponse({ success: true });
      }

      if (existingDoc.readonly) {
        throw forbiddenResponse("Cannot update readonly document");
      }

      if (!jsonContent || typeof jsonContent !== "string") {
        throw badRequestResponse("Content is required and must be a string");
      }

      content = jsonContent;
    } else {
      if (existingDoc.readonly) {
        throw forbiddenResponse("Cannot update readonly document");
      }

      const rawContent = await context.request.text();
      if (!rawContent) {
        throw badRequestResponse("Content is required and must be a string");
      }

      content = toHtmlIfMarkdown(rawContent, contentType);
    }

    // TODO: propper sanitization needed, parse html doc and only use allowed elements and attributes.
    const contentSanitized = stripScriptTags(content);

    const document = await updateDocument(spaceId, id, contentSanitized, userId);
    return jsonResponse({ document });
  }, "Failed to update document");

export const PATCH: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "documentId");

    const body = await parseJsonBody(context.request);
    const { properties, parentId, publishedRev, readonly } = body;

    await verifyDocumentRole(spaceId, id, user.id, "editor");

    if (properties !== undefined) {
      if (parentId !== undefined || publishedRev !== undefined || readonly !== undefined) {
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
        user.id,
        properties as Record<string, PropertyPatchValue>,
      );
      return successResponse(payload);
    }

    if (parentId !== undefined) {
      if (parentId !== null && typeof parentId !== "string") {
        throw badRequestResponse("Parent ID must be a string or null");
      }

      if (parentId) {
        await verifyDocumentAccess(spaceId, parentId, user.id);
      }

      await setDocumentParent(spaceId, id, parentId);
    }

    if (publishedRev !== undefined) {
      await handlePublishedRevisionPatch(spaceId, id, user.id, publishedRev);
    }

    if (readonly !== undefined) {
      await handleReadonlyPatch(spaceId, id, user.id, readonly);
    }

    sendSyncEvent("wiki_category_documents");

    return jsonResponse({ success: true });
  }, "Failed to patch document");

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const id = requireParam(context.params, "documentId");
    const permanent = context.url.searchParams.get("permanent") === "true";

    if (permanent) {
      await verifyDocumentRole(spaceId, id, user.id, "owner");
      await deleteDocument(spaceId, id, user.id);
    } else {
      await verifyDocumentRole(spaceId, id, user.id, "editor");
      await archiveDocument(spaceId, id, user.id);
    }

    return successResponse();
  }, "Failed to delete document");

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const documentId = requireParam(context.params, "documentId");

    await verifyDocumentAccess(spaceId, documentId, user.id);

    const document = await getDocument(spaceId, documentId);
    if (!document) {
      throw badRequestResponse("Document not found");
    }

    if (document.readonly) {
      throw forbiddenResponse("Cannot save readonly document");
    }

    const contentType = getMimeType(context.request.headers.get("Content-Type"));
    let html: string;
    let message: string | undefined;

    if (contentType === "application/json") {
      const body = await parseJsonBody(context.request);
      const { html: jsonHtml, message: jsonMessage } = body;

      if (!jsonHtml || typeof jsonHtml !== "string") {
        throw badRequestResponse("HTML content is required and must be a string");
      }

      html = jsonHtml;
      message = typeof jsonMessage === "string" ? jsonMessage : undefined;
    } else {
      const rawContent = await context.request.text();
      if (!rawContent) {
        throw badRequestResponse("Content is required and must be a string");
      }

      html = toHtmlIfMarkdown(rawContent, contentType);
    }

    const revision = await createRevision(spaceId, documentId, html, user.id, message);

    return jsonResponse({
      revision: {
        id: revision.id,
        documentId: revision.documentId,
        rev: revision.rev,
        checksum: revision.checksum,
        parentRev: revision.parentRev,
        message: revision.message,
        createdAt: revision.createdAt,
        createdBy: revision.createdBy,
      },
    });
  }, "Failed to create revision");
