import {
  authenticateDocumentAccess,
  authenticateJobTokenOrSpaceRole,
  authenticateSpaceAccess,
  spaceAccessToViewer,
} from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { documentEtag, preconditionFailed } from "#api/conditional.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  parsePaginationParams,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import {
  createDocument,
  getDocument,
  getDocumentChildren,
  InvalidDocumentParentError,
  listAllDocumentsByCategories,
  listArchivedDocuments,
  listDocuments,
  type PropertyInit,
} from "#db/space/documents.ts";
import {
  claimExternalIdentity,
  type ExternalIdentity,
  findExternalLink,
  isExternalIdentityTaken,
  listUnlinkedDocumentIds,
} from "#db/space/externalLinks.ts";
import { getSpace } from "#db/space/spaces.ts";
import {
  getDocumentTypeForContentType,
  getMimeType,
  prepareDocumentContent,
} from "#documents/content.ts";
import {
  propertyValueToText,
  ReservedDocumentPropertyKeyError,
} from "#documents/properties.ts";
import { isSerializedDocumentType, repositoryDocumentType } from "#documents/types.ts";
import { normalizeTimestamp } from "#utils/datetime.ts";
import {
  isRepositoryCreationEnabled,
  isWorkflowCreationEnabled,
} from "#utils/spacePreferences.ts";

/**
 * The external identity named by this request, or null when it names none.
 *
 * `source` and `externalId` travel together: half an identity is a mistake, not
 * a default.
 */
function externalIdentityFrom(
  source: unknown,
  externalId: unknown,
  instanceId: unknown,
): ExternalIdentity | null {
  if (source === undefined && externalId === undefined) return null;
  if (typeof source !== "string" || !source.trim()) {
    throw badRequestResponse("source must be a non-empty string");
  }
  if (typeof externalId !== "string" || !externalId.trim()) {
    throw badRequestResponse("externalId must be a non-empty string");
  }
  if (instanceId !== undefined && typeof instanceId !== "string") {
    throw badRequestResponse("instanceId must be a string");
  }
  return { source, externalId, instanceId: instanceId ?? "" };
}

function propertyInitToSlugText(value: PropertyInit | undefined): string | undefined {
  if (value === undefined) return undefined;

  if (Array.isArray(value)) {
    return propertyValueToText(value.map((item) => String(item)));
  }

  if (typeof value === "object" && value !== null && "value" in value) {
    return propertyInitToSlugText(value.value as PropertyInit | undefined);
  }

  if (value === null) return undefined;
  return String(value);
}

function parseDocumentTimestamp(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequestResponse(`${field} must be a valid date string`);
  }

  try {
    return normalizeTimestamp(value);
  } catch {
    throw badRequestResponse(`${field} must be a valid date string`);
  }
}

/**
 * List the documents of a space, or look one up by its external identity
 *
 * @tag Documents
 * @jobToken
 * @paginated
 * @query source With `externalId`, answer with the single document that
 *   identity names and its tag, instead of a listing.
 * @query externalId The peer's identifier for the document.
 * @query instanceId Which occurrence, for an identifier naming a series.
 * @query unlinked Answer with the ids of documents this source holds no
 *   identity for — what it has never been told about.
 * @query type Only documents of this document type.
 * @query categorySlugs Comma-separated category slugs to list documents from.
 * @query grouped:boolean With `categorySlugs`, group the result by category.
 * @query parentId List the children of this document instead of the space.
 * @query includeFiles:boolean Append the space's uploaded files as `file` entries.
 * @query archived:boolean List the archived (soft-deleted) documents instead. Takes `editor`.
 * @response #/components/schemas/DocumentPage
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const archived = new URL(context.req.url).searchParams.get("archived") === "true";

    // Resource-scoped grantees browse here too: a user shared into a single
    // category or document tree has no space-wide role, and the sidebar reads
    // its documents from this endpoint. `viewer` confines them to their grants.
    // The archive is the exception: reading an archived document takes
    // `editor`, so listing them does too, and a resource grant is not enough.
    const access = await authenticateSpaceAccess(
      context.var.credentials,
      spaceId,
      archived ? Permission.EDITOR : Permission.VIEWER,
      {
        allowResourceGrants: !archived,
      },
    );
    const viewer = spaceAccessToViewer(access);

    const { limit, cursor } = parsePaginationParams(
      new URL(context.req.url).searchParams,
      { defaultLimit: 50, maxLimit: 500 },
    );
    const typeParam =
      new URL(context.req.url).searchParams.get("type")?.trim() || undefined;
    const categorySlugsParam = new URL(context.req.url).searchParams.get("categorySlugs");
    const grouped = new URL(context.req.url).searchParams.get("grouped") === "true";
    // Uploaded files are unpaginated, so a listing only gets them on request.
    const includeFiles =
      new URL(context.req.url).searchParams.get("includeFiles") === "true";
    const parentIdParam =
      new URL(context.req.url).searchParams.get("parentId")?.trim() || undefined;

    const categorySlugs = categorySlugsParam
      ? categorySlugsParam
          .split(",")
          .map((slug) => slug.trim())
          .filter(Boolean)
      : [];

    const store = await openSpaceStore(spaceId);

    const params = new URL(context.req.url).searchParams;
    const identity = externalIdentityFrom(
      params.get("source") ?? undefined,
      params.get("externalId") ?? undefined,
      params.get("instanceId") ?? undefined,
    );
    if (identity) {
      const link = await findExternalLink(store, identity);
      if (!link) throw notFoundResponse("Document");
      // The space check above does not cover one document: this re-authorizes
      // against the document's own ACL, and raises the bar for an archived one.
      await authenticateDocumentAccess(
        context.var.credentials,
        spaceId,
        link.documentId,
        Permission.VIEWER,
      );
      const document = await getDocument(store, link.documentId);
      if (!document) throw notFoundResponse("Document");
      return jsonResponse({ document }, 200, {
        ETag: documentEtag(document.changeSeq),
      });
    }

    const unlinked = params.get("unlinked")?.trim();
    if (unlinked) {
      // Bare ids for the whole space, so a role in the space rather than a
      // grant on something inside it — the space check above admits a
      // resource-scoped grantee, which must not enumerate everything.
      await authenticateSpaceAccess(context.var.credentials, spaceId, Permission.EDITOR, {
        allowResourceGrants: false,
      });
      const documentIds = await listUnlinkedDocumentIds(store, unlinked, {
        limit,
        after: params.get("after") ?? undefined,
      });
      return jsonResponse({
        documentIds,
        nextCursor: documentIds.length === limit ? documentIds[limit - 1] : null,
      });
    }

    if (archived) {
      const { documents, nextCursor } = await listArchivedDocuments(store, viewer, {
        limit,
        cursor,
      });
      return jsonResponse({ documents, limit, nextCursor });
    }

    if (categorySlugs.length > 0) {
      const userEmail = access.user?.email;
      const documentsByCategory = await listAllDocumentsByCategories(
        store,
        categorySlugs,
        viewer,
        userEmail,
      );
      // The Map stays a Map for the lookups below — `categorySlugs` is raw query
      // input, and indexing a plain object with a slug like `__proto__` reads an
      // inherited member back instead of a bucket. It becomes an object only at
      // the point it is serialised, where `Object.fromEntries` defines own keys
      // and so is not fooled by the same slug.
      const filteredDocumentsByCategory = new Map(
        Array.from(
          documentsByCategory,
          ([slug, docs]) =>
            [
              slug,
              docs.filter(
                (doc) => doc.type !== "record" && (!typeParam || doc.type === typeParam),
              ),
            ] as const,
        ),
      );

      if (grouped) {
        return jsonResponse({
          documentsByCategory: Object.fromEntries(filteredDocumentsByCategory),
          categorySlugs,
        });
      }

      const seen = new Set<string>();
      const documents = [];

      for (const slug of categorySlugs) {
        const bucket = filteredDocumentsByCategory.get(slug) ?? [];
        for (const doc of bucket) {
          if (seen.has(doc.id)) continue;
          seen.add(doc.id);
          documents.push(doc);
        }
      }

      // The full filtered set ships in one response: `total` is its real count
      // and there is no page size to report.
      return jsonResponse({ documents, total: documents.length, nextCursor: null });
    }

    if (parentIdParam) {
      const documents = await getDocumentChildren(store, parentIdParam, viewer);
      // Unpaginated, as above: every child is returned regardless of `limit`.
      return jsonResponse({ documents, total: documents.length, nextCursor: null });
    }

    // Always return documents without content (content fetched separately when viewing)
    const { documents, total, nextCursor } = await listDocuments(store, {
      limit,
      type: typeParam,
      viewer,
      cursor,
      includeFiles,
    });
    return jsonResponse({ documents, total, limit, nextCursor });
  }, "Failed to list documents");

/**
 * Create a document
 *
 * Pass `source` and `externalId` to claim an external identity for it at the
 * same time, atomically: if that identity already names a document, nothing is
 * created and the answer is `412` carrying that document and its tag, so the
 * caller's next move is a conditional `PUT` rather than another create.
 *
 * @tag Documents
 * @jobToken
 * @body
 * @status 201
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const auth = await authenticateJobTokenOrSpaceRole(
      context.var.credentials,
      spaceId,
      Permission.EDITOR,
    );
    const userId = auth.type === "user" ? auth.user.id : auth.userId;
    if (!userId) {
      throw forbiddenResponse("Job token is missing user context");
    }

    const contentType = getMimeType(context.req.raw.headers.get("Content-Type"));
    let content: string;
    let properties: Record<string, PropertyInit> | undefined;
    let parentId: string | undefined;
    let type: string | undefined;
    let slugHint: string | undefined;
    let createdAt: Date | undefined;
    let updatedAt: Date | undefined;
    let readonly = false;
    let identity: ExternalIdentity | null = null;
    let remoteVersion: string | undefined;

    if (contentType === "application/json") {
      const body = (await parseJsonBody(context.req.raw)) as Record<string, unknown>;
      const jsonContent = body.content;
      const jsonProperties = body.properties;
      const jsonParentId = body.parentId;
      const jsonType = body.type;
      const jsonSlug = body.slug;
      const jsonCreatedAt = body.createdAt;
      const jsonUpdatedAt = body.updatedAt;
      const jsonReadonly = body.readonly;
      identity = externalIdentityFrom(body.source, body.externalId, body.instanceId);
      if (body.remoteVersion !== undefined && typeof body.remoteVersion !== "string") {
        throw badRequestResponse("remoteVersion must be a string");
      }
      remoteVersion = body.remoteVersion as string | undefined;
      const jsonBodyContentType =
        typeof body.contentType === "string" ? body.contentType : undefined;

      if (typeof jsonContent !== "string") {
        throw badRequestResponse("Content is required and must be a string");
      }

      content = jsonContent;
      properties =
        typeof jsonProperties === "object" &&
        jsonProperties !== null &&
        !Array.isArray(jsonProperties)
          ? (jsonProperties as Record<string, PropertyInit>)
          : undefined;
      parentId = typeof jsonParentId === "string" ? jsonParentId : undefined;
      type = typeof jsonType === "string" ? jsonType : undefined;
      if (jsonReadonly !== undefined && typeof jsonReadonly !== "boolean") {
        throw badRequestResponse("Readonly must be a boolean");
      }
      readonly = jsonReadonly ?? false;
      if (jsonSlug && typeof jsonSlug === "string") slugHint = jsonSlug;
      createdAt = parseDocumentTimestamp(jsonCreatedAt, "createdAt");
      updatedAt = parseDocumentTimestamp(jsonUpdatedAt, "updatedAt");
      if ((createdAt || updatedAt) && auth.type !== "job") {
        throw badRequestResponse(
          "Custom document timestamps require access-token or job-token authentication",
        );
      }
      if (!isSerializedDocumentType(type)) {
        content = prepareDocumentContent(content, jsonBodyContentType ?? null);
      }
    } else {
      const rawContent = await context.req.raw.text();
      const inferredType = getDocumentTypeForContentType(contentType);
      type = context.req.raw.headers.get("X-Document-Type") ?? inferredType;
      content = isSerializedDocumentType(type)
        ? rawContent
        : prepareDocumentContent(rawContent, contentType);
      const titleHeader = context.req.raw.headers.get("X-Document-Title");
      const slugHeader = context.req.raw.headers.get("X-Document-Slug");
      if (slugHeader) slugHint = slugHeader;
      if (titleHeader || slugHeader)
        properties = {
          ...(titleHeader ? { title: titleHeader } : {}),
          ...(slugHeader ? { slug: slugHeader } : {}),
        };
    }

    if (type === "workflow" || type === repositoryDocumentType) {
      const space = await getSpace(spaceId);
      if (type === "workflow" && !isWorkflowCreationEnabled(space?.preferences)) {
        throw forbiddenResponse("Workflow creation is disabled for this space");
      }
      if (
        type === repositoryDocumentType &&
        !isRepositoryCreationEnabled(space?.preferences)
      ) {
        throw forbiddenResponse("Repository creation is disabled for this space");
      }
    }

    const titleValue = properties?.title;
    const slugBase = slugHint || propertyInitToSlugText(titleValue) || "untitled";

    // createDocument now handles slug uniqueness internally
    const store = await openSpaceStore(spaceId);
    // One transaction, so a claim that loses its race takes the document with
    // it rather than leaving one nothing can ever find again.
    const document = await store
      .tx(async (tx) => {
        const created = await createDocument(tx, userId, slugBase, content, {
          properties,
          parentId,
          type,
          readonly,
          createdAt,
          updatedAt,
        });
        if (identity) {
          await claimExternalIdentity(
            tx,
            identity,
            created.id,
            remoteVersion ?? null,
            created.changeSeq,
          );
        }
        return created;
      })
      .catch((error) => {
        if (
          error instanceof InvalidDocumentParentError ||
          error instanceof ReservedDocumentPropertyKeyError
        ) {
          throw badRequestResponse(error.message);
        }
        if (identity && isExternalIdentityTaken(error)) return null;
        throw error;
      });

    // The identity already names a document. Answer with it and its tag, so the
    // caller's next move is a conditional PUT rather than another create.
    if (!document) {
      if (!identity) throw new Error("Document creation returned nothing");
      return externalConflict(store, identity);
    }

    return jsonResponse({ document }, 201, {
      ETag: documentEtag(document.changeSeq),
    });
  }, "Failed to create document");

async function externalConflict(
  store: SpaceStore,
  identity: ExternalIdentity,
): Promise<Response> {
  const link = await findExternalLink(store, identity);
  if (!link) throw new Error("External identity vanished after a unique violation");
  const current = await getDocument(store, link.documentId);
  if (!current) throw notFoundResponse("Document");
  return preconditionFailed(current, documentEtag(current.changeSeq));
}
