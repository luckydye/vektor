import {
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
  parseJsonBody,
  parsePaginationParams,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  createDocument,
  findDocumentByProperty,
  getDocumentChildren,
  InvalidDocumentParentError,
  listAllDocumentsByCategories,
  listArchivedDocuments,
  listDocuments,
  type PropertyInit,
} from "#db/space/documents.ts";
import { insertUniqueProperty } from "#db/space/properties.ts";
import { getSpace } from "#db/space/spaces.ts";
import {
  getDocumentTypeForContentType,
  getMimeType,
  prepareDocumentContent,
} from "#documents/content.ts";
import {
  parseStoredPropertyValue,
  propertyValueToText,
  ReservedDocumentPropertyKeyError,
  serializePropertyValue,
} from "#documents/properties.ts";
import { isSerializedDocumentType, repositoryDocumentType } from "#documents/types.ts";
import { normalizeTimestamp } from "#utils/datetime.ts";
import {
  isRepositoryCreationEnabled,
  isWorkflowCreationEnabled,
} from "#utils/spacePreferences.ts";

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
 * List the documents of a space
 *
 * @tag Documents
 * @jobToken
 * @paginated
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
 * The id is minted here and is never the caller's to choose. A caller that
 * knows a document by an identifier of its own puts that identifier in a
 * property and sends `If-None-Match: *` with `identityKey` naming it: the
 * document is then created only while no document in the space already carries
 * that key and value, and a collision answers `412` with the document that
 * does — which is also how the caller learns its id.
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
    let identityKeyField: unknown;
    let parentId: string | undefined;
    let type: string | undefined;
    let slugHint: string | undefined;
    let createdAt: Date | undefined;
    let updatedAt: Date | undefined;
    let readonly = false;

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
      const jsonBodyContentType =
        typeof body.contentType === "string" ? body.contentType : undefined;
      identityKeyField = body.identityKey;

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

    // `If-None-Match: *` on a create asks for the identity to be free. The URL
    // names a collection rather than a resource, so what the condition applies
    // to is named in the body instead.
    const identityKey =
      context.req.raw.headers.get("if-none-match")?.trim() === "*"
        ? requireIdentityKey(identityKeyField, properties)
        : null;

    // createDocument now handles slug uniqueness internally
    const store = await openSpaceStore(spaceId);
    const created = await store
      .tx(async (tx) => {
        // The identity property is held back from the create and written
        // conditionally below, so that a refusal rolls the document back.
        const withheld = identityKey
          ? Object.fromEntries(
              Object.entries(properties ?? {}).filter(([key]) => key !== identityKey),
            )
          : properties;

        const document = await createDocument(tx, userId, slugBase, content, {
          properties: withheld,
          parentId,
          type,
          readonly,
          createdAt,
          updatedAt,
        });

        if (!identityKey) return document;

        const value = serializePropertyValue(
          propertyInitValue(properties?.[identityKey]),
        );
        if (!(await insertUniqueProperty(tx, document.id, identityKey, value))) {
          throw new IdentityTakenError(identityKey, value);
        }
        // Written outside `touchDocument`, which would ordinarily be the bug
        // this file guards against — but the sequence `createDocument` just
        // allocated commits with this row, so no reader sees one without the
        // other and the tag still describes what landed.
        return {
          ...document,
          properties: {
            ...document.properties,
            [identityKey]: parseStoredPropertyValue(value),
          },
        };
      })
      .catch((error) => {
        if (
          error instanceof InvalidDocumentParentError ||
          error instanceof ReservedDocumentPropertyKeyError
        ) {
          throw badRequestResponse(error.message);
        }
        if (error instanceof IdentityTakenError) return error;
        throw error;
      });

    if (created instanceof IdentityTakenError) {
      const holder = await findDocumentByProperty(store, created.key, created.value);
      // The insert refused, so a document holds this identity. Anything else is
      // a bug rather than a state worth reporting.
      if (!holder) throw new Error("Identity is taken but no document holds it");
      return preconditionFailed(holder, documentEtag(holder.changeSeq));
    }

    return jsonResponse({ document: created }, 201, {
      ETag: documentEtag(created.changeSeq),
    });
  }, "Failed to create document");

/** The identity property was already claimed; carried out of the transaction. */
class IdentityTakenError extends Error {
  constructor(
    readonly key: string,
    readonly value: string,
  ) {
    super(`Property ${key} is already claimed`);
  }
}

/** A `PropertyInit` is either the value or `{ value, type }` around it. */
function propertyInitValue(init: PropertyInit | undefined): unknown {
  if (typeof init === "object" && init !== null && !Array.isArray(init) && "value" in init) {
    return init.value;
  }
  return init;
}

function requireIdentityKey(
  key: unknown,
  properties: Record<string, PropertyInit> | undefined,
): string {
  if (typeof key !== "string" || !key.trim()) {
    throw badRequestResponse("identityKey is required with If-None-Match");
  }
  if (properties?.[key] === undefined) {
    throw badRequestResponse(`identityKey "${key}" names no supplied property`);
  }
  return key;
}
