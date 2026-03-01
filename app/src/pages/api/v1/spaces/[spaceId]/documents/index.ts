import type { APIRoute } from "astro";
import {
  authenticateRequest,
  badRequestResponse,
  createdResponse,
  jsonResponse,
  parseJsonBody,
  parseQueryInt,
  requireParam,
  requireUser,
  verifySpaceRole,
  verifyTokenPermission,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  createDocument,
  listAllDocumentsByCategories,
  listDocuments,
} from "#db/documents.ts";
import { ResourceType } from "~/src/db/acl.ts";
import {
  getMimeType,
  toHtmlIfMarkdown,
} from "../../../../../../utils/documentContent.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");

    // Authenticate with either user session or access token
    const auth = await authenticateRequest(context, spaceId);

    // Handle token-based authentication
    if (auth.type === "token") {
      await verifyTokenPermission(
        auth.token,
        spaceId,
        ResourceType.SPACE,
        spaceId,
        "viewer",
      );
    } else {
      // Handle user-based authentication
      await verifySpaceRole(spaceId, auth.user.id, "viewer");
    }

    const limit = parseQueryInt(context.url.searchParams, "limit", {
      defaultValue: 100,
      min: 1,
      max: 1000,
    });
    const offset = parseQueryInt(context.url.searchParams, "offset", {
      defaultValue: 0,
      min: 0,
    });
    const categorySlugsParam = context.url.searchParams.get("categorySlugs");
    const grouped = context.url.searchParams.get("grouped") === "true";

    const categorySlugs = categorySlugsParam
      ? categorySlugsParam
          .split(",")
          .map((slug) => slug.trim())
          .filter(Boolean)
      : [];

    if (categorySlugs.length > 0) {
      const userEmail = auth.type === "token" ? undefined : auth.user.email;
      const documentsByCategory = await listAllDocumentsByCategories(
        spaceId,
        categorySlugs,
        userEmail,
      );

      if (grouped) {
        return jsonResponse({ documentsByCategory, categorySlugs });
      }

      const seen = new Set<string>();
      const documents = [];

      for (const slug of categorySlugs) {
        const bucket = documentsByCategory[slug] || [];
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
    const { documents, total } = await listDocuments(spaceId, limit, offset);
    return jsonResponse({ documents, total, limit, offset });
  }, "Failed to list documents");

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "editor");

    const contentType = getMimeType(context.request.headers.get("Content-Type"));
    let content: string;
    let properties: Record<string, unknown> | undefined;
    let parentId: string | undefined;
    let type: string | undefined;

    if (contentType === "application/json") {
      const body = await parseJsonBody(context.request);
      const {
        content: jsonContent,
        properties: jsonProperties,
        parentId: jsonParentId,
        type: jsonType,
      } = body;

      if (!jsonContent || typeof jsonContent !== "string") {
        throw badRequestResponse("Content is required and must be a string");
      }

      content = jsonContent;
      properties = jsonProperties;
      parentId = jsonParentId;
      type = jsonType;
    } else {
      const rawContent = await context.request.text();
      if (!rawContent) {
        throw badRequestResponse("Content is required and must be a string");
      }

      content = toHtmlIfMarkdown(rawContent, contentType);
    }

    if (!content || typeof content !== "string") {
      throw badRequestResponse("Content is required and must be a string");
    }

    const title = properties?.title || "untitled";

    // createDocument now handles slug uniqueness internally
    const document = await createDocument(
      spaceId,
      user.id,
      title,
      content,
      properties,
      parentId,
      type,
    );
    return createdResponse({ document });
  }, "Failed to create document");
