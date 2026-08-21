import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  createdResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getDocumentsByIds } from "#db/space/documents.ts";
import { createShareLink, listShareLinks } from "#db/space/shareLinks.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { addPositiveDays, isValidPositiveDayDuration } from "#utils/datetime.ts";

const MAX_SHARE_LINK_EXPIRY_DAYS = 365;
const MIN_SHARE_LINK_PASSWORD_LENGTH = 8;

const LINK_SCOPES = [ResourceType.DOCUMENT, ResourceType.DOCUMENT_TREE];

function requireLinkResource(resourceType: unknown, resourceId: unknown) {
  const scope = LINK_SCOPES.find((value) => value === resourceType);
  if (!scope) {
    throw badRequestResponse(`Resource type must be one of: ${LINK_SCOPES.join(", ")}`);
  }
  if (typeof resourceId !== "string" || resourceId.length === 0) {
    throw badRequestResponse("Resource ID is required");
  }
  return { resourceType: scope, resourceId };
}

function optionalPassword(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < MIN_SHARE_LINK_PASSWORD_LENGTH) {
    throw badRequestResponse(
      `Password must be at least ${MIN_SHARE_LINK_PASSWORD_LENGTH} characters`,
    );
  }
  return value;
}

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = new URL(context.req.url).searchParams.get("documentId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      documentId ? Permission.EDITOR : Permission.OWNER,
    );
    if (documentId) {
      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: documentId },
        user.id,
        Permission.EDITOR,
      );
    }

    const store = await openSpaceStore(spaceId);
    const links = await listShareLinks(
      store,
      documentId
        ? {
            resourceId: documentId,
            resourceTypes: [ResourceType.DOCUMENT, ResourceType.DOCUMENT_TREE],
          }
        : undefined,
    );
    if (documentId) return jsonResponse({ links });

    const documents = await getDocumentsByIds(
      store,
      links.map((link) => link.resourceId),
    );
    return jsonResponse({
      links: links.map((link) => {
        const document = documents.get(link.resourceId);
        return {
          ...link,
          resource: document
            ? {
                title: document.properties.title
                  ? propertyValueToText(document.properties.title)
                  : "Untitled",
                slug: document.slug,
                archived: document.archived,
              }
            : null,
        };
      }),
    });
  }, "Failed to list share links");

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.EDITOR,
    );

    const body = await parseJsonBody(context.req.raw);
    const { name, resourceType, resourceId, expiresInDays, password } = body;
    const resource = requireLinkResource(resourceType, resourceId);

    // `document_tree` stores a grant but is not itself an authorizable resource.
    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: resource.resourceId },
      user.id,
      Permission.EDITOR,
    );

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw badRequestResponse("Link name is required");
    }

    if (!isValidPositiveDayDuration(expiresInDays, MAX_SHARE_LINK_EXPIRY_DAYS)) {
      throw badRequestResponse(
        `expiresInDays must be greater than 0 and at most ${MAX_SHARE_LINK_EXPIRY_DAYS}`,
      );
    }

    const link = await createShareLink(await openSpaceStore(spaceId), {
      ...resource,
      name: name.trim(),
      expiresAt: addPositiveDays(new Date(), expiresInDays),
      password: optionalPassword(password),
      createdBy: user.id,
    });

    return createdResponse({ id: link.id, path: link.path });
  }, "Failed to create share link");
