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
  /** The peer's own version of the thing, stored so an unchanged one can be skipped. */
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

/**
 * Answer with the document as it now stands, so a caller that lost a race can
 * reconcile without a second round trip.
 */
async function conflict(store: SpaceStore, documentId: string): Promise<Response> {
  const current = await getDocument(store, documentId);
  if (!current) throw notFoundResponse("Document");
  return preconditionFailed(current, documentEtag(current.changeSeq));
}

/**
 * Create or replace the document a peer knows by its own identifier
 *
 * A conditional `PUT` to a name the caller chooses — the same shape as a
 * conditional write to an object store, and for the same reason: a syncing
 * peer has to be able to say "write this, but only if nobody beat me" without
 * a read and a write it cannot make atomic.
 *
 * `If-None-Match: *` creates and refuses to overwrite. `If-Match` overwrites
 * and refuses to create. Neither header upserts, which is what a first full
 * import wants.
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
      // `If-Match` names a state, and a document that does not exist has none.
      // 404 rather than 412, for the same reason a conditional read of a
      // missing resource is a 404: there is nothing to have failed a condition.
      if (ifMatch) throw notFoundResponse("Document");
      return createLinked(store, identity, userId, body);
    }

    // The identity is taken, and `If-None-Match: *` asked for it not to be.
    // Only `*` is meaningful here: a specific tag would be asking about a
    // representation of a document the caller does not yet claim to know.
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
 * Create the document and claim the identity in one transaction.
 *
 * Both or neither: a document created outside the claim is an orphan nothing
 * will ever find again, and a claim without a document points at nothing. The
 * unique index decides a race, and losing it rolls the document back with it.
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
      // Properties go through the patch path rather than the create options, so
      // that a create and an update apply a peer's fields the same way.
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
      // The only insert here that can fail is the identity index, and the only
      // way it fails is a second writer claiming the identity between the read
      // above and this transaction. A lost race, not a server fault.
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
    // Chained off the write above rather than the caller's condition: the
    // content write already moved the sequence, so re-using the original
    // condition here would refuse this half of the caller's own change.
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

/** SQLite reports the identity index by name; nothing else on this path can fail this way. */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}
