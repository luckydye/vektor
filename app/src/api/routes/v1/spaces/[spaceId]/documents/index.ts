import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  badRequestResponse,
  createdResponse,
  forbiddenResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  createDocument,
  getDocumentChildren,
  InvalidDocumentParentError,
  listAllDocumentsByCategories,
  listDocuments,
  type PropertyInit,
} from "#db/documents.ts";
import {
  authenticateJobTokenOrSpaceRole,
  authenticateSpaceAccess,
  spaceAccessToViewer,
} from "#utils/auth.ts";
import {
  getDocumentTypeForContentType,
  getMimeType,
  toHtmlIfMarkdown,
} from "#utils/documentContent.ts";
import { propertyValueToText } from "#utils/documentProperties.ts";

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

    const access = await authenticateSpaceAccess(context, spaceId, "viewer");
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
    const parentIdParam =
      new URL(context.req.url).searchParams.get("parentId")?.trim() || undefined;

    const categorySlugs = categorySlugsParam
      ? categorySlugsParam
          .split(",")
          .map((slug) => slug.trim())
          .filter(Boolean)
      : [];

    if (categorySlugs.length > 0) {
      const userEmail = access.user?.email;
      const documentsByCategory = await listAllDocumentsByCategories(
        spaceId,
        categorySlugs,
        userEmail,
        viewer,
      );
      const filteredDocumentsByCategory = Object.fromEntries(
        Object.entries(documentsByCategory).map(([slug, docs]) => [
          slug,
          docs.filter(
            (doc) => doc.type !== "record" && (!typeParam || doc.type === typeParam),
          ),
        ]),
      );

      if (grouped) {
        return jsonResponse({
          documentsByCategory: filteredDocumentsByCategory,
          categorySlugs,
        });
      }

      const seen = new Set<string>();
      const documents = [];

      for (const slug of categorySlugs) {
        const bucket = filteredDocumentsByCategory[slug] || [];
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
        offset: 0,
      });
    }

    if (parentIdParam) {
      const documents = await getDocumentChildren(spaceId, parentIdParam, viewer);
      return jsonResponse({
        documents,
        total: documents.length,
        limit: documents.length,
        nextCursor: null,
      });
    }

    // Always return documents without content (content fetched separately when viewing)
    const { documents, total, nextCursor } = await listDocuments(
      spaceId,
      limit,
      typeParam,
      viewer,
      cursor,
    );
    return jsonResponse({ documents, total, limit, nextCursor });
  }, "Failed to list documents");

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");
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

    const titleValue = properties?.title;
    const slugBase = slugHint || propertyInitToSlugText(titleValue) || "untitled";

    // createDocument now handles slug uniqueness internally
    const document = await createDocument(
      spaceId,
      userId,
      slugBase,
      content,
      properties,
      parentId,
      type,
      createdAt,
      updatedAt,
    ).catch((error) => {
      if (error instanceof InvalidDocumentParentError) {
        throw badRequestResponse(error.message);
      }
      throw error;
    });
    return createdResponse({ document });
  }, "Failed to create document");
