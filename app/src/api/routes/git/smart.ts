/**
 * Git smart HTTP: `git clone https://host/<space>/<repo>.git`.
 *
 * Everything protocol-shaped is `git-http-backend`'s job. This route decides
 * who is asking, whether they may, and — for a push — turns what landed on
 * local disk into published state.
 */

import { AclFailure } from "#acl/errors.ts";
import { canAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { type BasicAuthUser, verifyBasicAuth } from "#api/basicAuth.ts";
import type { ApiContext, ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getSpaceBySlug } from "#db/space/spaces.ts";
import { getFileStorage } from "#files/storage.ts";
import { ensureCache, invalidateCache, withRepoLock } from "#git/cache.ts";
import { runHttpBackend } from "#git/httpBackend.ts";
import { publishPush, readRefs } from "#git/publish.ts";
import { resolveRepository } from "#git/repos.ts";
import { appLogger } from "#observability/logger.ts";

/**
 * The conventional suffix on a clone URL. Optional here — the `git` segment in
 * the path already separates a repository from anything else in the space — but
 * accepted, because it is what people type.
 */
const GIT_SUFFIX = ".git";

function unauthorized(): Response {
  return new Response("Authentication required\n", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Vektor Git"',
      "Content-Type": "text/plain",
    },
  });
}

/**
 * One answer for a repository that is missing and one the caller may not see:
 * telling them apart would let anyone enumerate private repository names.
 */
function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

/** Which service a request is for, and therefore what it must be allowed to do. */
function isWrite(path: string, query: string): boolean {
  return path === "git-receive-pack" || query.includes("service=git-receive-pack");
}

async function authenticate(context: ApiContext): Promise<BasicAuthUser | null> {
  const user = context.var.user;
  if (user) return { id: user.id, email: user.email, name: user.name };
  return verifyBasicAuth(context.req.raw.headers.get("Authorization"));
}

/**
 * Whether `caller` holds `required` on the repository.
 *
 * A Basic-auth caller is judged on the grants of the token they presented, not
 * on their own access: a token scoped to one space at viewer must not become
 * the user's full reach everywhere they belong.
 */
async function mayReach(
  caller: BasicAuthUser,
  spaceId: string,
  documentId: string,
  required: Permission,
): Promise<boolean> {
  // The repository is a document, so this is document access: grants inherit
  // down the tree and a share link reaches it, exactly as for anything else.
  const target = { type: ResourceType.DOCUMENT, id: documentId };
  if (caller.token) {
    if (caller.token.spaceId !== spaceId) return false;
    return canAccess(spaceId, target, caller.token.result.tokenId, required);
  }
  return canAccess(spaceId, target, caller.id, required);
}

/**
 * Git smart HTTP reference discovery.
 *
 * @method GET
 * @tag Git
 * @param spaceSlug Slug of the space the repository belongs to.
 * @param repo Repository document slug.
 * @param gitPath Remaining smart-HTTP path, e.g. `info/refs` or `git-upload-pack`.
 * @note Git smart HTTP for a repository document. This is the clone URL, so it lives outside `/api`.
 */
/**
 * Git smart HTTP upload-pack / receive-pack.
 *
 * @method POST
 * @tag Git
 */
export const ALL: ApiRouteHandler = async (context) => {
  const spaceSlug = context.var.params.spaceSlug;
  const repoParam = context.var.params.repo;
  const path = context.var.params.gitPath;
  if (!spaceSlug || !repoParam || !path) return notFound();

  const slug = repoParam.endsWith(GIT_SUFFIX)
    ? repoParam.slice(0, -GIT_SUFFIX.length)
    : repoParam;

  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return notFound();

  const repository = await resolveRepository(await openSpaceStore(space.id), slug);
  if (!repository) return notFound();

  const caller = await authenticate(context);
  if (!caller) return unauthorized();

  const query = new URL(context.req.raw.url).search.slice(1);
  const write = isWrite(path, query);
  const required = write ? Permission.EDITOR : Permission.VIEWER;

  let allowed = false;
  try {
    allowed = await mayReach(caller, space.id, repository.id, required);
  } catch (error) {
    if (!(error instanceof AclFailure)) throw error;
  }
  // A reader who may not see the repository and one who may not push to it get
  // different answers: the second already knows it exists.
  if (!allowed) {
    if (!write) return notFound();
    return (await mayReach(caller, space.id, repository.id, Permission.VIEWER))
      ? new Response("Write access required\n", { status: 403 })
      : notFound();
  }

  // Archiving or locking a repository stops it accepting history without
  // hiding the history it already has.
  if (write && !repository.writable) {
    return new Response("Repository is archived or read-only\n", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const storage = getFileStorage();

  if (!write) {
    const cache = await ensureCache(
      storage,
      space.id,
      repository.id,
      repository.defaultBranch,
    );
    if (!cache) return notFound();
    const response = await runHttpBackend({
      dir: cache.dir,
      path,
      method: context.req.method,
      query,
      headers: context.req.raw.headers,
      body: context.req.raw.body,
      remoteUser: caller.email,
    });
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  }

  // A push mutates published state, so it runs alone for this repository and
  // its response is held until that state is actually published.
  return withRepoLock(space.id, repository.id, async () => {
    const cache = await ensureCache(
      storage,
      space.id,
      repository.id,
      repository.defaultBranch,
    );
    if (!cache) return notFound();

    const before = await readRefs(cache.dir);
    const response = await runHttpBackend({
      dir: cache.dir,
      path,
      method: context.req.method,
      query,
      headers: context.req.raw.headers,
      body: context.req.raw.body,
      remoteUser: caller.email,
    });

    // The advertisement half of a push publishes nothing; only the
    // receive-pack request itself changes refs.
    if (path !== "git-receive-pack") {
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    }

    // Buffered rather than streamed: receive-pack's status report is small, and
    // the client must not be told a push succeeded before it has been
    // published. The bytes are worth holding to keep that promise honest.
    const reported = await new Response(response.body).arrayBuffer();
    const result = await publishPush(
      storage,
      space.id,
      repository.id,
      cache.dir,
      cache.loaded,
      before,
    );

    if (!result.published) {
      // Local refs moved and nothing accepted them, so the cache is the only
      // copy of an update that never happened. Drop it.
      await invalidateCache(space.id, repository.id);
      appLogger.warn("Push rejected: refs moved underneath it", {
        spaceId: space.id,
        documentId: repository.id,
        refs: result.refUpdates.map((update) => update.name),
      });
      return new Response(
        "Rejected: another push moved these refs first. Fetch, rebase and try again.\n",
        { status: 409, headers: { "Content-Type": "text/plain" } },
      );
    }

    return new Response(reported, {
      status: response.status,
      headers: response.headers,
    });
  });
};
