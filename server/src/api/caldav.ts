import { ResourceUnavailableError } from "#acl/errors.ts";
import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { type BasicAuthUser, verifyBasicAuthUser } from "#api/basicAuth.ts";
import { withApiErrorHandling } from "#api/http.ts";
import type { ApiContext, ApiRouteHandler } from "#api/server/types.ts";
import type { DocumentWithProperties } from "#db/space/documents.ts";
import { getSpace, type Space } from "#db/space/spaces.ts";
import { propertyValueToText } from "#documents/properties.ts";
import type { Platform } from "#platform/platform.ts";

export type { BasicAuthUser };

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

    if (key === "SUMMARY") summary = unescapeICalText(value);
    else if (key === "DTSTART" || key === "DTEND") {
      const parsed = icalDateToISO(value, keyPart);
      if (!parsed) return null;
      if (key === "DTSTART") start = parsed;
      else end = parsed;
    }
  }

  if (!summary || !start) return null;
  return { summary, start, end: end ?? start };
}

/** Returns null for anything that is not a well-formed iCal date or date-time. */
function icalDateToISO(dateStr: string, keyPart: string): string | null {
  if (keyPart.includes("VALUE=DATE")) {
    const c = dateStr.replace(/\D/g, "");
    if (!/^\d{8}/.test(c)) return null;
    return `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T00:00:00.000Z`;
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/.exec(
    dateStr.replace(/[^0-9T]/g, ""),
  );
  if (!match) return null;
  const y = +match[1],
    mo = +match[2] - 1,
    d = +match[3];
  const h = +match[4],
    mi = +match[5],
    s = +(match[6] ?? 0);

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

/** RFC 5545 TEXT escaping — without it a title's newline injects arbitrary ICS. */
function escapeICalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/[;,]/g, "\\$&")
    .replace(/\r\n|[\r\n]/g, "\\n");
}

function unescapeICalText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

/** Fold a content line at 75 octets, never splitting a multi-byte character. */
function foldICalLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const prefix = chunks.length ? " " : "";
    let size = Math.min(75 - prefix.length, bytes.length - offset);
    while (size > 1 && (bytes[offset + size] & 0xc0) === 0x80) size--;
    chunks.push(prefix + bytes.toString("utf8", offset, offset + size));
    offset += size;
  }
  return chunks.join("\r\n");
}

/**
 * Whether a stored date property can be serialized at all. Property values are
 * user-controlled strings, and one that is not an ISO date used to throw a
 * RangeError that 500'd the whole feed. `Date` alone is too lenient a test — it
 * happily reads `"5"` as a year and emits `DTSTART:5`.
 */
function isValidDateString(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(
      value,
    ) &&
    !Number.isNaN(new Date(value).getTime()) &&
    !Number.isNaN(new Date(value.endsWith("Z") ? value : `${value}Z`).getTime())
  );
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
  const title = escapeICalText(titleValue ? propertyValueToText(titleValue) : doc.slug);

  if (!doc.properties.eventStart) return null;

  const startISO = propertyValueToText(doc.properties.eventStart);
  if (!isValidDateString(startISO)) return null;

  const storedEnd = doc.properties.eventEnd
    ? propertyValueToText(doc.properties.eventEnd)
    : null;
  const endISO =
    storedEnd && isValidDateString(storedEnd) ? storedEnd : defaultEndISO(startISO);
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
      lines.push(`DESCRIPTION:${escapeICalText(plainText)}`);
    }
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldICalLine).join("\r\n");
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

export async function requireBasicAuthUserAndAccess(
  context: ApiContext,
  options: { userId?: string; spaceId: string; requiredRole?: Permission },
): Promise<BasicAuthUser | Response> {
  const caldavUser = await verifyBasicAuthUser(context, options.spaceId);
  if (!caldavUser) {
    return calDavUnauthorized();
  }

  if (options.userId && options.userId !== caldavUser.id) {
    return calDavForbidden();
  }

  // Writes (PUT/DELETE) must require the corresponding role, not just read
  // access — a viewer must not be able to create/modify events. A token is
  // authorized on its own grants, never on the access of the user who made it.
  try {
    await verifyAccess(
      context.var.platform,
      options.spaceId,
      { type: ResourceType.SPACE, id: options.spaceId },
      caldavUser.token?.result.tokenId ?? caldavUser.id,
      options.requiredRole ?? Permission.VIEWER,
    );
  } catch {
    return calDavForbidden();
  }

  return caldavUser;
}

/**
 * Whether a PROPFIND asks for the children too. RFC 4918 reads a missing `Depth`
 * as infinity, which here is one level, since nothing below a calendar is listed.
 */
export function listsChildren(context: ApiContext): boolean {
  if (context.req.raw.method.toUpperCase() !== "PROPFIND") return false;
  return context.req.raw.headers.get("Depth") !== "0";
}

/** The space behind a calendar the caller was just authorized on. */
export async function requireCalendarSpace(
  platform: Platform,
  spaceId: string,
): Promise<Space> {
  const space = await getSpace(platform, spaceId);
  if (!space) throw new Error(`Space ${spaceId} passed authorization but cannot be read`);
  return space;
}

/** A space as a calendar inside a calendar home's PROPFIND listing. */
export function calendarEntry(userId: string, space: Space): string {
  return `  <d:response>
    <d:href>/api/caldav/calendars/${userId}/${space.id}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>${escapeXml(space.name)}</d:displayname>
        <cs:getctag>${space.updatedAt.getTime()}</cs:getctag>
        <apple:calendar-color>${escapeXml(space.preferences.brandColor || "#1e293b")}</apple:calendar-color>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;
}

/**
 * Authorize the caller for one document inside a space they already passed the
 * space-level check for. Space access is not document access: without this the
 * route hands out documents a per-document ACL withholds, and misses the
 * archived-document rule the guard layer raises. Token callers are authorized
 * against the token's grants, matching {@link requireBasicAuthUserAndAccess}.
 *
 * @returns The refusal to return, or null when the caller may proceed.
 */
export async function authorizeCalDAVDocument(
  platform: Platform,
  caldavUser: BasicAuthUser,
  spaceId: string,
  documentId: string,
  requiredRole: Permission,
): Promise<Response | null> {
  try {
    await verifyAccess(
      platform,
      spaceId,
      { type: ResourceType.DOCUMENT, id: documentId },
      caldavUser.token?.result.tokenId ?? caldavUser.id,
      requiredRole,
    );
  } catch (error) {
    if (error instanceof ResourceUnavailableError) {
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }
    return calDavForbidden();
  }
  return null;
}

/**
 * Answer an unexpected throw with the standard error handler instead of a bare
 * 500, so one malformed stored value cannot take a polling calendar client's
 * whole sync down.
 */
export function caldavRoute(handler: ApiRouteHandler): ApiRouteHandler {
  return (context) => withApiErrorHandling(() => handler(context));
}
