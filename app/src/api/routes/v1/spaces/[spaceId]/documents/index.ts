import type { APIRoute } from "astro";
import { getTokenUserId } from "#db/accessTokens.ts";
import { getUserGroups, ResourceType } from "#db/acl.ts";
import {
  authenticateRequest,
  badRequestResponse,
  createdResponse,
  forbiddenResponse,
  jsonResponse,
  parseJsonBody,
  parsePaginationParams,
  requireParam,
  verifySpaceRole,
  verifyTokenPermission,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  type AclViewer,
  createDocument,
  listAllDocumentsByCategories,
  listDocuments,
} from "#db/documents.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";
import {
  getDocumentTypeForContentType,
  getMimeType,
  toHtmlIfMarkdown,
} from "#utils/documentContent.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");

    const jobAuth = context.request.headers.get("X-Job-Token")
      ? await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer")
      : null;
    const auth = jobAuth ? null : await authenticateRequest(context, spaceId);

    if (!jobAuth && auth?.type === "token") {
      await verifyTokenPermission(
        auth.token,
        spaceId,
        ResourceType.SPACE,
        spaceId,
        "viewer",
      );
    }
    if (!jobAuth && auth?.type === "user") {
      await verifySpaceRole(spaceId, auth.user.id, "viewer");
    }

    // Identity for per-document ACL filtering. Only trusted server-minted job
    // tokens without user context (userId === null) get the unfiltered view.
    const aclUserId = jobAuth
      ? jobAuth.type === "user"
        ? jobAuth.user.id
        : jobAuth.userId
      : auth.type === "user"
        ? auth.user.id
        : getTokenUserId(auth.token.tokenId);
    const viewer: AclViewer | null = aclUserId
      ? { userId: aclUserId, userGroups: await getUserGroups(aclUserId) }
      : null;

    const { limit, offset } = parsePaginationParams(context.url.searchParams);
    const cursor = context.url.searchParams.get("cursor") || undefined;
    const typeParam = context.url.searchParams.get("type")?.trim() || undefined;
    const categorySlugsParam = context.url.searchParams.get("categorySlugs");
    const grouped = context.url.searchParams.get("grouped") === "true";

    const categorySlugs = categorySlugsParam
      ? categorySlugsParam
          .split(",")
          .map((slug) => slug.trim())
          .filter(Boolean)
      : [];

    if (categorySlugs.length > 0) {
      const userEmail = auth?.type === "user" ? auth.user.email : undefined;
      const documentsByCategory = await listAllDocumentsByCategories(
        spaceId,
        categorySlugs,
        userEmail,
        viewer,
      );
      const filteredDocumentsByCategory = typeParam
        ? Object.fromEntries(
            Object.entries(documentsByCategory).map(([slug, docs]) => [
              slug,
              docs.filter((doc) => doc.type === typeParam),
            ]),
          )
        : documentsByCategory;

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

    // Always return documents without content (content fetched separately when viewing)
    const { documents, total, nextCursor } = await listDocuments(
      spaceId,
      limit,
      offset,
      typeParam,
      viewer,
      cursor,
    );
    return jsonResponse({ documents, total, limit, offset, nextCursor });
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
    let createdAt: Date | undefined;
    let updatedAt: Date | undefined;

    if (contentType === "application/json") {
      const body = await parseJsonBody(context.request);
      const {
        content: jsonContent,
        properties: jsonProperties,
        parentId: jsonParentId,
        type: jsonType,
        createdAt: jsonCreatedAt,
        updatedAt: jsonUpdatedAt,
      } = body;

      if (!jsonContent || typeof jsonContent !== "string") {
        throw badRequestResponse("Content is required and must be a string");
      }

      content = jsonContent;
      properties = jsonProperties;
      parentId = jsonParentId;
      type = jsonType;
      if (jsonCreatedAt && typeof jsonCreatedAt === "string")
        createdAt = new Date(jsonCreatedAt);
      if (jsonUpdatedAt && typeof jsonUpdatedAt === "string")
        updatedAt = new Date(jsonUpdatedAt);
      content = toHtmlIfMarkdown(content, contentType, type);
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
      if (titleHeader || slugHeader)
        properties = {
          ...(titleHeader ? { title: titleHeader } : {}),
          ...(slugHeader ? { slug: slugHeader } : {}),
        };
    }

    if (!content || typeof content !== "string") {
      throw badRequestResponse("Content is required and must be a string");
    }

    const title = properties?.title || "untitled";

    // createDocument now handles slug uniqueness internally
    const document = await createDocument(
      spaceId,
      userId,
      title,
      content,
      properties,
      parentId,
      type,
      createdAt,
      updatedAt,
    );
    return createdResponse({ document });
  }, "Failed to create document");
