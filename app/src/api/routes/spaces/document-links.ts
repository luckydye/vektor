import { authenticateSpaceAccess } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  parseQueryInt,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  type ExternalIdentity,
  listExternalLinks,
  markExternalSynced,
} from "#db/space/externalLinks.ts";

const MAX_RECORDED_LINKS = 500;

interface RecordedSync extends ExternalIdentity {
  remoteVersion?: string | null;
  syncedChangeSeq: number;
  expectedSyncedChangeSeq?: number;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequestResponse(`${field} must be a non-empty string`);
  }
  return value;
}

function parseRecordedSync(raw: unknown, source: string): RecordedSync {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw badRequestResponse("Each link must be an object");
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.syncedChangeSeq !== "number") {
    throw badRequestResponse("syncedChangeSeq must be a number");
  }
  if (
    entry.expectedSyncedChangeSeq !== undefined &&
    typeof entry.expectedSyncedChangeSeq !== "number"
  ) {
    throw badRequestResponse("expectedSyncedChangeSeq must be a number");
  }
  if (
    entry.remoteVersion !== undefined &&
    entry.remoteVersion !== null &&
    typeof entry.remoteVersion !== "string"
  ) {
    throw badRequestResponse("remoteVersion must be a string or null");
  }
  if (entry.instanceId !== undefined && typeof entry.instanceId !== "string") {
    throw badRequestResponse("instanceId must be a string");
  }

  return {
    source,
    externalId: requireString(entry.externalId, "externalId"),
    instanceId: (entry.instanceId as string | undefined) ?? "",
    remoteVersion: entry.remoteVersion as string | null | undefined,
    syncedChangeSeq: entry.syncedChangeSeq,
    expectedSyncedChangeSeq: entry.expectedSyncedChangeSeq as number | undefined,
  };
}

/**
 * Read a source's external identities and where its sync got to
 *
 * Everything a reconciling run needs in one scan: `changeSeq` against
 * `syncedChangeSeq` says whether the document changed here, `remoteVersion`
 * says what the peer last had. Documents are not included — the run fetches
 * only the ones it decides to pull.
 *
 * Deleted identities are listed with `deletedAt` set. A consumer that keeps no
 * state of its own cannot tell "deleted here" from "never imported", and
 * leaving them out would have it recreate what someone deleted.
 *
 * Paged on `externalId`, which is unique within a source and never changes, so
 * a pass spanning several requests sees each identity exactly once even while
 * documents are being written.
 *
 * @tag Documents
 * @jobToken
 * @query source Which peer's identities to read. Required.
 * @query after Continue after this `externalId`.
 * @query limit Page size, 1-500.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const searchParams = new URL(context.req.url).searchParams;
    const source = requireString(searchParams.get("source"), "source");

    // Every identity in the space, so a role in the space rather than a grant on
    // something inside it. Individual documents are not filtered here: this is a
    // sync surface, and a caller who can read it can see which ids a source
    // tracks.
    await authenticateSpaceAccess(context.var.credentials, spaceId, Permission.EDITOR, {
      allowResourceGrants: false,
    });

    const limit = parseQueryInt(searchParams, "limit", {
      defaultValue: 100,
      min: 1,
      max: 500,
    });

    const store = await openSpaceStore(spaceId);
    const states = await listExternalLinks(store, source, {
      limit,
      after: searchParams.get("after") ?? undefined,
    });

    const links = states.map(({ link, changeSeq }) => ({ ...link, changeSeq }));
    const nextCursor =
      links.length === limit ? links[links.length - 1].externalId : null;
    return jsonResponse({ links, nextCursor });
  }, "Failed to read external links");

/**
 * Record what a source has now synced
 *
 * Sent after the writes it describes, in one request rather than one per
 * document. `expectedSyncedChangeSeq` makes an entry conditional, for two
 * workers sharing one source: without it the later write wins, with it the
 * loser is told so in `rejected`.
 *
 * @tag Documents
 * @jobToken
 * @body
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    await authenticateSpaceAccess(context.var.credentials, spaceId, Permission.EDITOR, {
      allowResourceGrants: false,
    });

    const body = await parseJsonBody<Record<string, unknown>>(context.req.raw);
    const source = requireString(body.source, "source");
    if (!Array.isArray(body.links)) {
      throw badRequestResponse("links must be an array");
    }
    if (body.links.length > MAX_RECORDED_LINKS) {
      throw badRequestResponse(`links must hold at most ${MAX_RECORDED_LINKS} entries`);
    }
    const entries = body.links.map((raw) => parseRecordedSync(raw, source));

    const store = await openSpaceStore(spaceId);
    const rejected: ExternalIdentity[] = [];
    for (const entry of entries) {
      const identity: ExternalIdentity = {
        source: entry.source,
        externalId: entry.externalId,
        instanceId: entry.instanceId,
      };
      const recorded = await markExternalSynced(
        store,
        identity,
        {
          remoteVersion: entry.remoteVersion,
          syncedChangeSeq: entry.syncedChangeSeq,
        },
        entry.expectedSyncedChangeSeq,
      );
      if (!recorded) rejected.push(identity);
    }

    return jsonResponse({ recorded: entries.length - rejected.length, rejected });
  }, "Failed to record external links");
