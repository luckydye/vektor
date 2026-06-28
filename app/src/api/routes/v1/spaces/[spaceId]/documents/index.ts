import type { APIRoute } from "astro";
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
  listAllDocumentsByCategories,
  listDocuments,
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

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");

    const access = await authenticateSpaceAccess(context, spaceId, "viewer");
    const viewer = spaceAccessToViewer(access);

    const limitParam = context.url.searchParams.get("limit");
    const limitNum = limitParam ? parseInt(limitParam, 10) : NaN;
    const limit =
      Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, 500) : 50;
    const cursor = context.url.searchParams.get("cursor") || undefined;
    const typeParam = context.url.searchParams.get("type")?.trim() || undefined;
    const categorySlugsParam = context.url.searchParams.get("categorySlugs");
    const grouped = context.url.searchParams.get("grouped") === "true";
    const parentIdParam = context.url.searchParams.get("parentId")?.trim() || undefined;

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

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");
    const userId = auth.type === "user" ? auth.user.id : auth.userId;
    if (!userId) {
      throw forbiddenResponse("Job token is missing user context");
    }

    const contentType = getMimeType(context.request.headers.get("Content-Type"));
    let content: string;
    let properties: Record<string, unknown> | undefined;
    let parentId: string | undefined;
    let type: string | undefined;
    let slugHint: string | undefined;
    let createdAt: Date | undefined;
    let updatedAt: Date | undefined;

    if (contentType === "application/json") {
      const body = await parseJsonBody(context.request);
      const {
        content: jsonContent,
        properties: jsonProperties,
        parentId: jsonParentId,
        type: jsonType,
        slug: jsonSlug,
        createdAt: jsonCreatedAt,
        updatedAt: jsonUpdatedAt,
        contentType: jsonBodyContentType,
      } = body;

      if (!jsonContent || typeof jsonContent !== "string") {
        throw badRequestResponse("Content is required and must be a string");
      }

      content = jsonContent;
      properties = jsonProperties;
      parentId = jsonParentId;
      type = jsonType;
      if (jsonSlug && typeof jsonSlug === "string") slugHint = jsonSlug;
      if (jsonCreatedAt && typeof jsonCreatedAt === "string")
        createdAt = new Date(jsonCreatedAt);
      if (jsonUpdatedAt && typeof jsonUpdatedAt === "string")
        updatedAt = new Date(jsonUpdatedAt);
      content = toHtmlIfMarkdown(content, jsonBodyContentType ?? contentType, type);
    } else {
      const rawContent = await context.request.text();
      if (!rawContent) {
        throw badRequestResponse("Content is required and must be a string");
      }

      type =
        context.request.headers.get("X-Document-Type") ??
        getDocumentTypeForContentType(contentType);
      content = toHtmlIfMarkdown(rawContent, contentType, type);
      const titleHeader = context.request.headers.get("X-Document-Title");
      const slugHeader = context.request.headers.get("X-Document-Slug");
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

    const slugBase = slugHint || (properties?.title as string | undefined) || "untitled";

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
    );
    return createdResponse({ document });
  }, "Failed to create document");
