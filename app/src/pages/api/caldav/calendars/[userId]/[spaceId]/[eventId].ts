import type { APIRoute } from "astro";
import {
  documentToICal,
  optionsPreflight,
  parseICalEvent,
  requireCalDAVUserAndAccess,
  CORS_HEADERS,
} from "../../../../../../db/caldav.ts";
import {
  createDocument,
  getDocument,
  updateDocumentProperty,
} from "../../../../../../db/documents.ts";

/**
 * CalDAV individual event endpoint.
 * GET  – serves a single document as text/calendar.
 * PUT  – creates or updates a document from iCal data.
 *        On create, responds 201 with a Location header pointing to the canonical URL.
 * The eventId parameter includes the .ics extension (e.g., {docId}.ics).
 */
export const OPTIONS: APIRoute = () => optionsPreflight();

export const GET: APIRoute = async (context) => {
  const { userId, spaceId, eventId } = context.params;
  const caldavUser = await requireCalDAVUserAndAccess(context, { userId, spaceId });
  if (caldavUser instanceof Response) return caldavUser;

  const docId = eventId.replace(/\.ics$/, "");
  const doc = await getDocument(spaceId, docId);
  if (!doc) return new Response("Not Found", { status: 404 });

  const ical = documentToICal(doc);
  if (!ical) return new Response("Not Found", { status: 404 });

  return new Response(ical, {
    status: 200,
    headers: { "Content-Type": "text/calendar; charset=utf-8", ...CORS_HEADERS },
  });
};

export const PUT: APIRoute = async (context) => {
  const { userId, spaceId, eventId } = context.params;
  const caldavUser = await requireCalDAVUserAndAccess(context, { userId, spaceId });
  if (caldavUser instanceof Response) return caldavUser;

  const icalText = await context.request.text();
  const event = parseICalEvent(icalText);
  if (!event) return new Response("Bad Request", { status: 400 });

  const docId = eventId.replace(/\.ics$/, "");
  const existing = await getDocument(spaceId, docId);

  if (existing) {
    await updateDocumentProperty(
      spaceId,
      docId,
      "title",
      event.summary,
      null,
      caldavUser.id,
    );
    await updateDocumentProperty(
      spaceId,
      docId,
      "eventStart",
      event.start,
      "date",
      caldavUser.id,
    );
    await updateDocumentProperty(
      spaceId,
      docId,
      "eventEnd",
      event.end,
      "date",
      caldavUser.id,
    );
    return new Response(null, {
      status: 204,
      headers: { ETag: `"${docId}"`, ...CORS_HEADERS },
    });
  }

  const doc = await createDocument(spaceId, caldavUser.id, event.summary, "", {
    title: event.summary,
  });
  await updateDocumentProperty(
    spaceId,
    doc.id,
    "eventStart",
    event.start,
    "date",
    caldavUser.id,
  );
  await updateDocumentProperty(
    spaceId,
    doc.id,
    "eventEnd",
    event.end,
    "date",
    caldavUser.id,
  );
  return new Response(null, {
    status: 201,
    headers: {
      Location: `/api/caldav/calendars/${caldavUser.id}/${spaceId}/${doc.id}.ics`,
      ETag: `"${doc.id}"`,
      ...CORS_HEADERS,
    },
  });
};
