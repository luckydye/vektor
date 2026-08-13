import {
  authenticateJobTokenOrSpaceRole,
  authenticateSpaceAccess,
  spaceAccessToViewer,
} from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  createdResponse,
  forbiddenResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  createDocument,
  EmptyDocumentSlugError,
  getDocumentChildren,
  InvalidDocumentParentError,
  listAllDocumentsByCategories,
  listDocuments,
  type PropertyInit,
} from "#db/space/documents.ts";
import { getSpace } from "#db/space/spaces.ts";
import {
  getDocumentTypeForContentType,
  getMimeType,
  toHtmlIfMarkdown,
} from "#documents/content.ts";
import {
  propertyValueToText,
  ReservedDocumentPropertyKeyError,
} from "#documents/properties.ts";
import { isWorkflowCreationEnabled } from "#utils/spacePreferences.ts";

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

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");

    // Resource-scoped grantees browse here too: a user shared into a single
    // category or document tree has no space-wide role, and the sidebar reads
    // its documents from this endpoint. `viewer` confines them to their grants.
    const access = await authenticateSpaceAccess(context, spaceId, Permission.VIEWER, {
      allowResourceGrants: true,
    });
    const viewer = spaceAccessToViewer(access);

    const limitParam = new URL(context.req.url).searchParams.get("limit");
    const limitNum = limitParam ? parseInt(limitParam, 10) : NaN;
    const limit =
      Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, 500) : 50;
    const cursor = new URL(context.req.url).searchParams.get("cursor") || undefined;
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

      return jsonResponse({
        documents,
        total: documents.length,
        limit: documents.length,
      });
    }

    if (parentIdParam) {
      const documents = await getDocumentChildren(store, parentIdParam, viewer);
      return jsonResponse({
        documents,
        total: documents.length,
        limit: documents.length,
        nextCursor: null,
      });
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

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const auth = await authenticateJobTokenOrSpaceRole(
      context,
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

    if (contentType === "application/json") {
      const body = (await parseJsonBody(context.req.raw)) as Record<string, unknown>;
      const jsonContent = body.content;
      const jsonProperties = body.properties;
      const jsonParentId = body.parentId;
      const jsonType = body.type;
      const jsonSlug = body.slug;
      const jsonCreatedAt = body.createdAt;
      const jsonUpdatedAt = body.updatedAt;
      const jsonBodyContentType =
        typeof body.contentType === "string" ? body.contentType : undefined;

      if (!jsonContent || typeof jsonContent !== "string") {
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
      if (jsonSlug && typeof jsonSlug === "string") slugHint = jsonSlug;
      if (jsonCreatedAt && typeof jsonCreatedAt === "string")
        createdAt = new Date(jsonCreatedAt);
      if (jsonUpdatedAt && typeof jsonUpdatedAt === "string")
        updatedAt = new Date(jsonUpdatedAt);
      content = toHtmlIfMarkdown(content, jsonBodyContentType ?? contentType, type);
    } else {
      const rawContent = await context.req.raw.text();
      if (!rawContent) {
        throw badRequestResponse("Content is required and must be a string");
      }

      type =
        context.req.raw.headers.get("X-Document-Type") ??
        getDocumentTypeForContentType(contentType);
      content = toHtmlIfMarkdown(rawContent, contentType, type);
      const titleHeader = context.req.raw.headers.get("X-Document-Title");
      const slugHeader = context.req.raw.headers.get("X-Document-Slug");
      if (slugHeader) slugHint = slugHeader;
      if (titleHeader || slugHeader)
        properties = {
          ...(titleHeader ? { title: titleHeader } : {}),
          ...(slugHeader ? { slug: slugHeader } : {}),
        };
    }

    if (!content || typeof content !== "string") {
      throw badRequestResponse("Content is required and must be a string");
    }

    if (type === "workflow") {
      const space = await getSpace(spaceId);
      if (!isWorkflowCreationEnabled(space?.preferences)) {
        throw forbiddenResponse("Workflow creation is disabled for this space");
      }
    }

    const titleValue = properties?.title;
    const slugBase = slugHint || propertyInitToSlugText(titleValue) || "untitled";

    // createDocument now handles slug uniqueness internally
    const store = await openSpaceStore(spaceId);
    const document = await createDocument(
      store,
      userId,
      slugBase,
      content,
      properties,
      parentId,
      type,
      createdAt,
      updatedAt,
    ).catch((error) => {
      if (
        error instanceof InvalidDocumentParentError ||
        error instanceof EmptyDocumentSlugError ||
        error instanceof ReservedDocumentPropertyKeyError
      ) {
        throw badRequestResponse(error.message);
      }
      throw error;
    });
    return createdResponse({ document });
  }, "Failed to create document");
