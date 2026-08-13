import { Permission } from "#acl/permissions.ts";
import {
  CORS_HEADERS,
  documentToICal,
  optionsPreflight,
  parseICalEvent,
  requireCalDAVUserAndAccess,
} from "#api/caldav.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { createDocument, getDocument } from "#db/space/documents.ts";
import { patchDocumentProperties } from "#db/space/properties.ts";

/**
 * CalDAV individual event endpoint.
 * GET  – serves a single document as text/calendar.
 * PUT  – creates or updates a document from iCal data.
 *        On create, responds 201 with a Location header pointing to the canonical URL.
 * The eventId parameter includes the .ics extension (e.g., {docId}.ics).
 */
export const OPTIONS: ApiRouteHandler = () => optionsPreflight();

export const GET: ApiRouteHandler = async (context) => {
  const { userId, spaceId, eventId } = context.var.params;
  if (!spaceId || !eventId) return new Response("Bad Request", { status: 400 });
  const caldavUser = await requireCalDAVUserAndAccess(context, { userId, spaceId });
  if (caldavUser instanceof Response) return caldavUser;

  const docId = eventId.replace(/\.ics$/, "");
  const doc = await getDocument(await openSpaceStore(spaceId), docId);
  if (!doc) return new Response("Not Found", { status: 404 });

  const ical = documentToICal(doc);
  if (!ical) return new Response("Not Found", { status: 404 });

  return new Response(ical, {
    status: 200,
    headers: { "Content-Type": "text/calendar; charset=utf-8", ...CORS_HEADERS },
  });
};

export const PUT: ApiRouteHandler = async (context) => {
  const { userId, spaceId, eventId } = context.var.params;
  if (!spaceId || !eventId) return new Response("Bad Request", { status: 400 });
  const caldavUser = await requireCalDAVUserAndAccess(context, {
    userId,
    spaceId,
    requiredRole: Permission.EDITOR,
  });
  if (caldavUser instanceof Response) return caldavUser;

  const icalText = await context.req.raw.text();
  const event = parseICalEvent(icalText);
  if (!event) return new Response("Bad Request", { status: 400 });

  const docId = eventId.replace(/\.ics$/, "");
  const store = await openSpaceStore(spaceId);
  const existing = await getDocument(store, docId);

  if (existing) {
    await patchDocumentProperties(
      store,
      docId,
      {
        title: event.summary,
        eventStart: { value: event.start, type: "date" },
        eventEnd: { value: event.end, type: "date" },
      },
      caldavUser.id,
    );
    return new Response(null, {
      status: 204,
      headers: { ETag: `"${docId}"`, ...CORS_HEADERS },
    });
  }

  const doc = await createDocument(
    store,
    caldavUser.id,
    event.summary,
    "",
    {
      title: event.summary,
      eventStart: { value: event.start, type: "date" },
      eventEnd: { value: event.end, type: "date" },
    },
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
