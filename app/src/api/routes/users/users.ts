import { desc, eq, inArray } from "drizzle-orm";
import { verifyAccess } from "#acl/guards.ts";
import { isInstanceAdmin } from "#acl/instanceGroups.ts";
import {
  GROUP_NAME_PATTERN,
  Permission,
  PUBLIC_GROUP,
  ResourceType,
} from "#acl/permissions.ts";
import { getSpaceMemberIds } from "#acl/store.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseQueryInt,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getAuthDb } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { user } from "#db/schema/auth.ts";
import { resolveProfileImage } from "#utils/gravatar.ts";

/**
 * Every parameter this route understands. An unrecognized one is a `400` rather
 * than the unscoped form: `?userId=` is a misspelling of `?id=`, and answering it
 * with the register — or, for anyone else, with the empty list a client draws as
 * an instance with nobody in it — hides the mistake instead of naming it.
 */
const KNOWN_PARAMS = new Set(["id", "spaceId", "limit", "offset"]);

/**
 * How many accounts one register answer carries, and the most it will carry when
 * asked for more. A register is a listing like any other here, so it is bounded
 * like one: `/users/suggestions` caps at 20, and an instance with ten thousand
 * accounts must not turn one request into the whole table, or one page into ten
 * thousand rows. `offset` walks past the cap for whoever needs the rest.
 */
const REGISTER_DEFAULT_LIMIT = 500;
const REGISTER_MAX_LIMIT = 1000;

/**
 * The stored group claim as a list, without the freshness bound and the
 * synthetic `public` that {@link import("#acl/userGroups.ts").getUserGroups}
 * adds: the register prints what the IdP last said, it does not authorize
 * anything. Malformed names are dropped for the same reason as there — nothing
 * the IdP wrote is trusted to be a group name.
 */
function storedGroups(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (group): group is string =>
        typeof group === "string" &&
        group !== PUBLIC_GROUP &&
        GROUP_NAME_PATTERN.test(group),
    );
  } catch {
    return [];
  }
}

/**
 * GET /api/v1/users
 *
 * How much of the user table a caller may see, which is a different answer for
 * an ordinary member than for whoever administers the instance:
 *   - `?id=<userId>`     → single minimal profile (id, name, image)
 *   - `?spaceId=<id>`    → members of a space the caller belongs to, the same
 *                          minimal profiles
 *   - unscoped           → the register: accounts with their email, group claim
 *                          and join date, for an instance admin — and an empty
 *                          list for anyone else. `?limit=` / `?offset=` page it,
 *                          newest first, bounded whether or not they are given.
 *
 * The scoped forms are deliberately narrow, and stay so: they are what any
 * signed-in account may ask, and an unscoped listing there would dump the table
 * and every address in it. Unscoped is the register, and what makes it
 * answerable is that an instance admin is owner on every space that exists — it
 * shows them nothing they could not read a space at a time. Anyone else gets an
 * empty array, not a refusal: this is a listing of what the caller may see, and
 * for them that is nothing. Inviting people is still done by email through the
 * permissions endpoint; nobody needs the register for that.
 *
 * A parameter this route does not know is a `400`, whichever form it would
 * otherwise have selected: the scopes are how a caller says what it wants, and a
 * misspelled one must not silently become a different question.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const caller = requireUser(context);
    const db = getAuthDb();

    const params = new URL(context.req.url).searchParams;
    for (const name of params.keys()) {
      if (!KNOWN_PARAMS.has(name)) {
        throw badRequestResponse(`Unknown query parameter '${name}'`);
      }
    }

    // An empty value is not a scope: `?id=` is a caller that meant to name
    // somebody, and letting it fall through would answer the register instead.
    for (const name of ["id", "spaceId"]) {
      if (params.has(name) && !params.get(name)?.trim()) {
        throw badRequestResponse(`'${name}' must not be empty`);
      }
    }

    const id = params.get("id");
    const spaceId = params.get("spaceId");

    // Paging belongs to the register: the scoped forms answer one profile or one
    // space's members, so a limit there is a request this route cannot honour and
    // ignoring it would be the same silence as answering a misspelled scope.
    if ((id || spaceId) && (params.has("limit") || params.has("offset"))) {
      throw badRequestResponse(
        "'limit' and 'offset' apply only to the unscoped register",
      );
    }

    // Email is selected only so resolveProfileImage can derive a Gravatar URL
    // from it; toPublicProfile drops it again, so it never leaves the server.
    const profileFields = {
      id: user.id,
      name: user.name,
      image: user.image,
      email: user.email,
    } as const;

    const toPublicProfile = (row: {
      id: string;
      name: string;
      image: string | null;
      email: string;
    }) => ({
      id: row.id,
      name: row.name,
      image: resolveProfileImage(row),
    });

    if (id) {
      const result = await one(
        db.select(profileFields).from(user).where(eq(user.id, id)),
      );
      if (!result) {
        throw notFoundResponse("User");
      }
      return jsonResponse(toPublicProfile(result));
    }

    if (spaceId) {
      // Only members of the space may enumerate its members.
      await verifyAccess(
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        caller.id,
        Permission.VIEWER,
      );

      const memberIds = [...(await getSpaceMemberIds(spaceId))];
      // The space creator may not have an explicit ACL row; include the caller.
      if (!memberIds.includes(caller.id)) {
        memberIds.push(caller.id);
      }
      if (memberIds.length === 0) {
        return jsonResponse([]);
      }

      const members = await db
        .select(profileFields)
        .from(user)
        .where(inArray(user.id, memberIds));
      return jsonResponse(members.map(toPublicProfile));
    }

    // Read before the caller's standing is, so a malformed page is the same 400
    // for everyone: what a route accepts is not a thing to learn from who asks.
    const limit = parseQueryInt(params, "limit", {
      defaultValue: REGISTER_DEFAULT_LIMIT,
      min: 1,
      max: REGISTER_MAX_LIMIT,
    });
    const offset = parseQueryInt(params, "offset", { defaultValue: 0, min: 0 });

    // Everything the caller may see, which is every account for an instance admin
    // and none for anyone else — the same shape of answer as `/spaces` and
    // `/search`, rather than a refusal. `isInstanceAdmin` filters here, it does
    // not gate: nothing is withheld from a caller who could name it, because
    // there is nothing to name.
    if (!(await isInstanceAdmin(caller.id))) {
      return jsonResponse([]);
    }

    const accounts = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        groups: user.groups,
        createdAt: user.createdAt,
      })
      .from(user)
      // `id` breaks ties rather than decorating the order: accounts seeded in one
      // transaction share a timestamp, and without a total order two pages of the
      // same register can show the same row twice and never show another.
      .orderBy(desc(user.createdAt), desc(user.id))
      .limit(limit)
      .offset(offset);

    return jsonResponse(
      accounts.map((row) => ({
        id: row.id,
        name: row.name,
        // The register's reason for existing, unlike toPublicProfile above.
        email: row.email,
        image: resolveProfileImage(row),
        groups: storedGroups(row.groups),
        createdAt: row.createdAt,
      })),
    );
  }, "Failed to list users");
