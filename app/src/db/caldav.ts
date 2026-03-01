import { eq } from "drizzle-orm";
import type { APIContext } from "astro";
import type { DocumentWithProperties } from "./documents.ts";
import { getAuthDb } from "./db.ts";
import { user } from "./schema/auth.ts";
import { listUserSpaces } from "./spaces.ts";
import { validateAccessToken } from "./accessTokens.ts";
import { verifySpaceAccess } from "./api.ts";

export interface CalDAVUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Authenticate a CalDAV request using either session cookies or HTTP Basic auth.
 * Session auth is checked first (for browser-based clients), then Basic auth
 * with email:access_token (for external CalDAV clients).
 */
export async function verifyCalDAVUser(context: APIContext): Promise<CalDAVUser | null> {
  const sessionUser = context.locals.user;
  if (sessionUser) {
    return { id: sessionUser.id, email: sessionUser.email, name: sessionUser.name };
  }
  return verifyBasicAuth(context.request.headers.get("Authorization"));
}

/**
 * Authenticate a CalDAV request using HTTP Basic auth.
 * Username is the user's email, password is an access token (at_...).
 * The token is validated against any space the user has access to.
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

  const authDb = getAuthDb();
  const foundUser = await authDb.select().from(user).where(eq(user.email, email)).get();
  if (!foundUser) return null;

  const spaces = await listUserSpaces(foundUser.id);
  for (const space of spaces) {
    const result = await validateAccessToken(token, space.id);
    if (result && result.token.createdBy === foundUser.id) {
      return { id: foundUser.id, email: foundUser.email, name: foundUser.name };
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
  const d = new Date(startISO + "Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, -1);
}

/**
 * Serialize a wiki document to iCal VCALENDAR format.
 */
export function documentToICal(doc: DocumentWithProperties): string | null {
  const title = (doc.properties.title || doc.slug).replace(/[\\;,]/g, "\\$&");

  if (!doc.properties.eventStart) return null;

  const startISO = doc.properties.eventStart;
  const endISO = doc.properties.eventEnd ?? defaultEndISO(startISO);
  const dtstamp = formatICalDateTime(doc.updatedAt);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Wiki//CalDAV//EN",
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
      "WWW-Authenticate": 'Basic realm="Wiki CalDAV"',
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

export async function requireCalDAVUserAndAccess(
  context: APIContext,
  options: { userId?: string; spaceId?: string },
): Promise<CalDAVUser | Response> {
  const caldavUser = await verifyCalDAVUser(context);
  if (!caldavUser) {
    return calDavUnauthorized();
  }

  if (options.userId && options.userId !== caldavUser.id) {
    return calDavForbidden();
  }

  if (options.spaceId) {
    try {
      await verifySpaceAccess(options.spaceId, caldavUser.id);
    } catch {
      return calDavForbidden();
    }
  }

  return caldavUser;
}
