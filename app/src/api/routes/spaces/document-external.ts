import { authenticateJobTokenOrSpaceRole, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { documentEtag, expectedSeqs, preconditionFailed } from "#api/conditional.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiContext, ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import {
  createDocument,
  type DocumentMeta,
  getDocument,
  updateDocument,
} from "#db/space/documents.ts";
import {
  claimExternalIdentity,
  type ExternalIdentity,
  findExternalLink,
  markExternalSynced,
} from "#db/space/externalLinks.ts";
import {
  patchDocumentProperties,
  type PatchDocumentPropertiesResult,
} from "#db/space/properties.ts";
import type { DocumentPropertyPatch } from "#documents/properties.ts";

interface ExternalUpsertBody {
  /** Which occurrence, for a peer whose id names a series. Empty is the series. */
  instanceId?: string;
  /** The peer's own version, so an unchanged one can be skipped next run. */
  remoteVersion?: string;
  slug?: string;
  content?: string;
  type?: string | null;
  properties?: DocumentPropertyPatch;
}

function parseBody(raw: unknown): ExternalUpsertBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw badRequestResponse("Body must be an object");
  }
  const body = raw as Record<string, unknown>;
  for (const key of ["instanceId", "remoteVersion", "slug", "content"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      throw badRequestResponse(`${key} must be a string`);
    }
  }
  if (body.type !== undefined && body.type !== null && typeof body.type !== "string") {
    throw badRequestResponse("type must be a string or null");
  }
  if (
    body.properties !== undefined &&
    (typeof body.properties !== "object" ||
      body.properties === null ||
      Array.isArray(body.properties))
  ) {
    throw badRequestResponse("properties must be an object");
  }
  return body as ExternalUpsertBody;
}

function respond(document: DocumentMeta, status: 200 | 201): Response {
  return jsonResponse({ document }, status, { ETag: documentEtag(document.changeSeq) });
}

async function conflict(store: SpaceStore, documentId: string): Promise<Response> {
  const current = await getDocument(store, documentId);
  if (!current) throw notFoundResponse("Document");
  return preconditionFailed(current, documentEtag(current.changeSeq));
}

/**
 * Create or replace the document a peer knows by its own identifier
 *
 * `If-None-Match: *` creates and refuses to overwrite; `If-Match` overwrites
 * and refuses to create; neither header upserts.
 *
 * @tag Documents
 * @jobToken
 * @param source Which peer, so two calendars claiming one id stay distinct.
 * @param externalId The peer's identifier for this document.
 * @body
 */
export const PUT: ApiRouteHandler = (context: ApiContext) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const source = requireParam(context.var.params, "source");
    const externalId = requireParam(context.var.params, "externalId");

    const auth = await authenticateJobTokenOrSpaceRole(
      context.var.credentials,
      spaceId,
      Permission.EDITOR,
    );
    const userId = auth.type === "user" ? auth.user.id : auth.userId;
    if (!userId) {
      throw forbiddenResponse("Job token is missing user context");
    }

    const body = parseBody(await parseJsonBody<unknown>(context.req.raw));
    const identity: ExternalIdentity = {
      source,
      externalId,
      instanceId: body.instanceId ?? "",
    };

    const store = await openSpaceStore(spaceId);
    const ifMatch = context.req.raw.headers.get("if-match");
    const ifNoneMatch = context.req.raw.headers.get("if-none-match");
    const link = await findExternalLink(store, identity);

    if (!link) {
      // No resource, so no state to have failed a condition.
      if (ifMatch) throw notFoundResponse("Document");
      return createLinked(store, identity, userId, body);
    }

    // Only `*` is meaningful on a create-or-update.
    if (ifNoneMatch?.trim() === "*") {
      return conflict(store, link.documentId);
    }

    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: link.documentId },
      userId,
      Permission.EDITOR,
    );

    const seqs = ifMatch ? expectedSeqs(ifMatch) : undefined;
    const expected = seqs === "any" || seqs === undefined ? undefined : seqs;
    return updateLinked(store, identity, link.documentId, userId, body, expected);
  }, "Failed to write external document");

/**
 * Both or neither: a document created outside the claim is an orphan. The unique
 * index decides a race, and losing it rolls the document back with it.
 */
async function createLinked(
  store: SpaceStore,
  identity: ExternalIdentity,
  userId: string,
  body: ExternalUpsertBody,
): Promise<Response> {
  const documentId = await store
    .tx(async (tx) => {
      const document = await createDocument(
        tx,
        userId,
        body.slug ?? identity.externalId,
        body.content ?? "",
        { type: body.type ?? undefined },
      );
      // The patch path, not the create options, so create and update agree.
      const patched: PatchDocumentPropertiesResult = body.properties
        ? await patchDocumentProperties(tx, document.id, body.properties, userId)
        : {};
      await claimExternalIdentity(
        tx,
        identity,
        document.id,
        body.remoteVersion ?? null,
        patched.changeSeq ?? document.changeSeq,
      );
      return document.id;
    })
    .catch((error: unknown) => {
      // Only the identity index can fail here, and only if a second writer
      // claimed it since the read above.
      if (isUniqueViolation(error)) return null;
      throw error;
    });

  if (documentId === null) {
    const existing = await findExternalLink(store, identity);
    if (!existing) {
      throw new Error("External identity vanished after a unique violation");
    }
    return conflict(store, existing.documentId);
  }

  const document = await getDocument(store, documentId);
  if (!document) throw notFoundResponse("Document");
  return respond(document, 201);
}

async function updateLinked(
  store: SpaceStore,
  identity: ExternalIdentity,
  documentId: string,
  userId: string,
  body: ExternalUpsertBody,
  expected: number[] | undefined,
): Promise<Response> {
  let changeSeq: number | undefined;

  if (body.content !== undefined) {
    const written = await updateDocument(
      store,
      documentId,
      body.content,
      body.type,
      expected,
    );
    if (!written.ok) {
      if (written.reason === "missing") throw notFoundResponse("Document");
      return conflict(store, documentId);
    }
    changeSeq = written.document.changeSeq;
  }

  if (body.properties !== undefined) {
    // Chained off the write above: reusing the caller's condition here would
    // refuse this half of its own change.
    const patched = await patchDocumentProperties(
      store,
      documentId,
      body.properties,
      userId,
      changeSeq === undefined ? expected : [changeSeq],
    );
    if (patched.conflict) return conflict(store, documentId);
    changeSeq = patched.changeSeq ?? changeSeq;
  }

  if (changeSeq === undefined) {
    throw badRequestResponse("Nothing to write: provide content or properties");
  }

  await markExternalSynced(store, identity, body.remoteVersion ?? null, changeSeq);

  const document = await getDocument(store, documentId);
  if (!document) throw notFoundResponse("Document");
  return respond(document, 200);
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}
