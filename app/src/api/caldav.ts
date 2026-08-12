import { eq } from "drizzle-orm";
import {
  verifySpaceAccess,
  verifySpaceRole,
  verifyTokenPermission,
} from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { withApiErrorHandling } from "#api/http.ts";
import type { ApiContext } from "#api/server/types.ts";
import { getAuthDb } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { user } from "#db/schema/auth.ts";
import { type ValidateTokenResult, validateAccessToken } from "#db/space/accessTokens.ts";
import {
  type DocumentWithProperties,
  InvalidDocumentParentError,
} from "#db/space/documents.ts";
import { listUserSpaces } from "#db/space/spaces.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { isNoAuthMode, LOCAL_USER, LOCAL_USER_ID } from "#noAuth";

/**
 * The access token a Basic-auth CalDAV client authenticated with.
 *
 * `spaceId` is the space whose store holds the token row. Access tokens live in
 * exactly one space's database, so that space is the only one a token can ever
 * reach — every other space the user belongs to is out of the token's scope by
 * construction, and `result` carries the ACL identity (`token:<id>`) that says
 * what it may do *within* that space.
 */
export interface CalDAVToken {
  spaceId: string;
  result: ValidateTokenResult;
}

export interface CalDAVUser {
  id: string;
  email: string;
  name: string;
  /**
   * Set only for callers that authenticated with an access token over Basic
   * auth. Its presence means the caller's authority is the *token's* ACL
   * grants, not the user's own access — the user identity only records who
   * delegated the token (and whose name new documents are attributed to).
   * Session callers leave it undefined and keep being authorized against their
   * own ACL.
   */
  token?: CalDAVToken;
}

/**
 * Authenticate a CalDAV request using either session cookies or HTTP Basic auth.
 * Session auth is checked first (for browser-based clients), then Basic auth
 * with email:access_token (for external CalDAV clients).
 */
export async function verifyCalDAVUser(context: ApiContext): Promise<CalDAVUser | null> {
  const sessionUser = context.var.user;
  if (sessionUser) {
    return { id: sessionUser.id, email: sessionUser.email, name: sessionUser.name };
  }
  return verifyBasicAuth(context.req.raw.headers.get("Authorization"));
}

/**
 * Authenticate a CalDAV request using HTTP Basic auth.
 * Username is the user's email, password is an access token (at_...).
 *
 * The returned identity carries the token that authenticated it: the token is
 * NOT merely a way to look the user up. Callers must authorize against
 * {@link CalDAVUser.token} (see {@link requireCalDAVUserAndAccess}), otherwise a
 * token scoped to one space at viewer level would grant the user's full access
 * to every space they belong to.
 */
export async function verifyBasicAuth(
  authHeader: string | null,
): Promise<CalDAVUser | null> {
  if (!authHeader?.startsWith("Basic ")) return null;

  let decoded: string;
  try {
    decoded = atob(authHeader.slice(6));
  } catch {
    return null;
  }

  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) return null;

  const email = decoded.slice(0, colonIdx);
  const token = decoded.slice(colonIdx + 1);

  if (isNoAuthMode() && email === LOCAL_USER.email) {
    return { id: LOCAL_USER_ID, email: LOCAL_USER.email, name: LOCAL_USER.name };
  }

  const authDb = getAuthDb();
  const foundUser = await one(authDb.select().from(user).where(eq(user.email, email)));
  if (!foundUser) return null;

  // A token row exists only in the database of the space it was created in, so
  // this search establishes *which* space the token belongs to — it can never
  // "find" a space-A token by probing space B. The space it is found in is
  // carried out as the token's scope.
  const spaces = await listUserSpaces(foundUser.id);
  for (const space of spaces) {
    const result = await validateAccessToken(await openSpaceStore(space.id), token);
    if (result && result.token.createdBy === foundUser.id) {
      return {
        id: foundUser.id,
        email: foundUser.email,
        name: foundUser.name,
        token: { spaceId: space.id, result },
      };
    }
  }

  return null;
}

export interface ParsedICalEvent {
  summary: string;
  start: string;
  end: string;
}

/**
 * Parse the SUMMARY, DTSTART and DTEND out of a VCALENDAR/VEVENT block.
 * Returns null if the required fields are missing.
 */
export function parseICalEvent(icalText: string): ParsedICalEvent | null {
  const unfolded = icalText.replace(/(\r\n|\r|\n)[ \t]/g, "");
  const lines = unfolded.split(/\r?\n|\r/);

  let summary: string | undefined;
  let start: string | undefined;
  let end: string | undefined;
  let inEvent = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "BEGIN:VEVENT") {
      inEvent = true;
      continue;
    }
    if (trimmed === "END:VEVENT") break;
    if (!inEvent) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const keyPart = trimmed.slice(0, colonIdx);
    const value = trimmed.slice(colonIdx + 1);
    const key = keyPart.split(";")[0];

    if (key === "SUMMARY") summary = value.replace(/\\([\\;,])/g, "$1");
    else if (key === "DTSTART") start = icalDateToISO(value, keyPart);
    else if (key === "DTEND") end = icalDateToISO(value, keyPart);
  }

  if (!summary || !start) return null;
  return { summary, start, end: end ?? start };
}

function icalDateToISO(dateStr: string, keyPart: string): string {
  if (keyPart.includes("VALUE=DATE")) {
    const c = dateStr.replace(/\D/g, "");
    return `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T00:00:00.000Z`;
  }

  const c = dateStr.replace(/[^0-9T]/g, "");
  const y = +c.slice(0, 4),
    mo = +c.slice(4, 6) - 1,
    d = +c.slice(6, 8);
  const h = +c.slice(9, 11),
    mi = +c.slice(11, 13),
    s = +c.slice(13, 15) || 0;

  if (dateStr.endsWith("Z")) {
    return new Date(Date.UTC(y, mo, d, h, mi, s)).toISOString();
  }

  const tzidMatch = keyPart.match(/TZID=([^;:]+)/);
  if (tzidMatch) {
    try {
      // Reverse-offset trick: find the UTC instant whose wall-clock in `tzid` matches the given digits.
      const utcGuess = Date.UTC(y, mo, d, h, mi, s);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tzidMatch[1],
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(new Date(utcGuess));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      const tzAsUtc = Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour") % 24,
        get("minute"),
        get("second"),
      );
      return new Date(utcGuess + (utcGuess - tzAsUtc)).toISOString();
    } catch {
      // Unknown timezone, fall through to treating digits as UTC
    }
  }

  // Floating time — preserve wall-clock without timezone conversion
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${y}-${p(mo + 1)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}.000`;
}

function formatICalDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function formatICalDateTime(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/** Returns the appropriate DTSTART/DTEND line for a stored ISO string (UTC or floating). */
function formatDtProp(prop: string, isoStr: string): string {
  if (isoStr.endsWith("Z")) {
    const d = new Date(isoStr);
    if (
      d.getUTCHours() === 0 &&
      d.getUTCMinutes() === 0 &&
      d.getUTCSeconds() === 0 &&
      d.getUTCMilliseconds() === 0
    ) {
      return `${prop};VALUE=DATE:${formatICalDateOnly(d)}`;
    }
    return `${prop}:${formatICalDateTime(d)}`;
  }
  // Floating — strip separators and milliseconds, output without Z
  const compact = isoStr
    .replace(/-/g, "")
    .replace(/:/g, "")
    .replace(/\.\d{3}$/, "");
  return `${prop}:${compact}`;
}

/** Default end = start + 1 day, preserving UTC vs floating. */
function defaultEndISO(startISO: string): string {
  if (startISO.endsWith("Z")) {
    const d = new Date(startISO);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }
  // Floating — temporarily parse as UTC to do date math, then strip the Z
  const d = new Date(`${startISO}Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, -1);
}

/**
 * Serialize a wiki document to iCal VCALENDAR format.
 */
export function documentToICal(doc: DocumentWithProperties): string | null {
  const titleValue = doc.properties.title;
  const title = (titleValue ? propertyValueToText(titleValue) : doc.slug).replace(
    /[\\;,]/g,
    "\\$&",
  );

  if (!doc.properties.eventStart) return null;

  const startISO = propertyValueToText(doc.properties.eventStart);
  const endISO = doc.properties.eventEnd
    ? propertyValueToText(doc.properties.eventEnd)
    : defaultEndISO(startISO);
  const dtstamp = formatICalDateTime(doc.updatedAt);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vektor//CalDAV//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${doc.id}`,
    `DTSTAMP:${dtstamp}`,
    formatDtProp("DTSTART", startISO),
    formatDtProp("DTEND", endISO),
    `SUMMARY:${title}`,
  ];

  if (doc.content) {
    const plainText = doc.content
      .replace(/<[^>]*>/g, "")
      .trim()
      .slice(0, 500);
    if (plainText) {
      lines.push(`DESCRIPTION:${plainText.replace(/\n/g, "\\n")}`);
    }
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, PROPFIND, REPORT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Depth",
  "Access-Control-Max-Age": "86400",
};

export function optionsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Escape a dynamic value for interpolation into XML element content or
 * attribute values. User-controlled data (space names, emails, preferences)
 * must never reach the multistatus documents unescaped.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function xmlResponse(body: string, status = 207): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      DAV: "1, calendar-access",
      ...CORS_HEADERS,
    },
  });
}

export function calDavUnauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Vektor CalDAV"',
      ...CORS_HEADERS,
    },
  });
}

export function calDavForbidden(): Response {
  return new Response("Forbidden", {
    status: 403,
    headers: CORS_HEADERS,
  });
}

/**
 * Authorize a Basic-auth CalDAV caller against the *token's* grants.
 *
 * This is the CalDAV counterpart of the API path's `verifyTokenPermission` and
 * deliberately never consults the user's own ACL: an access token exists to
 * delegate limited access, so a token scoped "viewer on space A" must not reach
 * space B and must not write anywhere, no matter what its creator may do.
 *
 * `spaceId` is the space named in the CalDAV URL, absent for the principal and
 * calendar-home collections — those are authorized against the token's own
 * space, so a credential that holds nothing there cannot browse at all.
 */
async function authorizeCalDAVToken(
  caldavUser: CalDAVUser,
  token: CalDAVToken,
  spaceId: string | undefined,
  requiredRole: Permission,
): Promise<CalDAVUser | Response> {
  // The token reaches exactly one space (see CalDAVToken). Any other space in
  // the URL is outside its scope, whatever the user themselves may access.
  if (spaceId && spaceId !== token.spaceId) {
    return calDavForbidden();
  }

  const targetSpaceId = spaceId ?? token.spaceId;
  try {
    await verifyTokenPermission(
      token.result,
      targetSpaceId,
      ResourceType.SPACE,
      targetSpaceId,
      requiredRole,
    );
  } catch {
    return calDavForbidden();
  }

  return caldavUser;
}

export function calDavBadRequest(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: CORS_HEADERS,
  });
}

/**
 * The API routes' error handling, in the form a calendar client can read.
 *
 * The CalDAV handlers used to be bare `async (context) => …`, so a validation
 * error thrown by the document layer left the router unhandled and reached the
 * client as a generic 500 — which a syncing calendar can only retry, and which
 * leaks whatever the exception happened to say. Known validation failures become
 * a plain-text 4xx; anything else stays a logged 500, exactly as under
 * `withApiErrorHandling` elsewhere.
 */
export function withCalDavErrorHandling(
  handler: () => Promise<Response> | Response,
  fallbackMessage: string,
): Promise<Response> {
  return withApiErrorHandling(handler, {
    fallbackMessage,
    onError: (error) =>
      error instanceof InvalidDocumentParentError
        ? calDavBadRequest(error.message)
        : undefined,
  });
}

export async function requireCalDAVUserAndAccess(
  context: ApiContext,
  options: { userId?: string; spaceId?: string; requiredRole?: Permission },
): Promise<CalDAVUser | Response> {
  const caldavUser = await verifyCalDAVUser(context);
  if (!caldavUser) {
    return calDavUnauthorized();
  }

  if (options.userId && options.userId !== caldavUser.id) {
    return calDavForbidden();
  }

  // Writes (PUT/DELETE) must require the corresponding role, not just read
  // access — a viewer must not be able to create/modify events.
  const requiredRole = options.requiredRole ?? Permission.VIEWER;

  // An access token's authority is its own ACL grants, never the access of the
  // user who created it. Checked before anything space-scoped so that even the
  // collections without a space in their URL stay inside the token's scope.
  if (caldavUser.token) {
    return authorizeCalDAVToken(
      caldavUser,
      caldavUser.token,
      options.spaceId,
      requiredRole,
    );
  }

  if (options.spaceId) {
    try {
      if (requiredRole !== Permission.VIEWER) {
        await verifySpaceRole(options.spaceId, caldavUser.id, requiredRole);
      } else {
        await verifySpaceAccess(options.spaceId, caldavUser.id);
      }
    } catch {
      return calDavForbidden();
    }
  }

  return caldavUser;
}
