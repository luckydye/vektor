import { Permission } from "#acl/permissions.ts";
import {
  authorizeCalDAVDocument,
  CORS_HEADERS,
  caldavRoute,
  documentToICal,
  optionsPreflight,
  parseICalEvent,
  requireBasicAuthUserAndAccess,
} from "#api/caldav.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { createDocument, getDocument } from "#db/space/documents.ts";
import { patchDocumentProperties } from "#db/space/properties.ts";

/**
 * Advertise the methods this calendar object supports
 *
 * @tag CalDAV
 * @param eventId Calendar object (`.ics`) name, e.g. `{docId}.ics`.
 * @note CalDAV individual event endpoint: GET serves a document as text/calendar, PUT creates or updates one from iCal data (responding 201 with a Location header on create).
 */
export const OPTIONS: ApiRouteHandler = () => optionsPreflight();

/**
 * Read one calendar object
 *
 * @tag CalDAV
 * @param eventId Calendar object (`.ics`) name.
 */
export const GET: ApiRouteHandler = caldavRoute(async (context) => {
  const { userId, spaceId, eventId } = context.var.params;
  if (!spaceId || !eventId) return new Response("Bad Request", { status: 400 });
  const caldavUser = await requireBasicAuthUserAndAccess(context, { userId, spaceId });
  if (caldavUser instanceof Response) return caldavUser;

  const docId = eventId.replace(/\.ics$/, "");
  const denied = await authorizeCalDAVDocument(
    caldavUser,
    spaceId,
    docId,
    Permission.VIEWER,
  );
  if (denied) return denied;

  const doc = await getDocument(await openSpaceStore(spaceId), docId);
  if (!doc) return new Response("Not Found", { status: 404 });

  const ical = documentToICal(doc);
  if (!ical) return new Response("Not Found", { status: 404 });

  return new Response(ical, {
    status: 200,
    headers: { "Content-Type": "text/calendar; charset=utf-8", ...CORS_HEADERS },
  });
});

/**
 * Create or replace one calendar object
 *
 * @tag CalDAV
 * @param eventId Calendar object (`.ics`) name.
 */
export const PUT: ApiRouteHandler = caldavRoute(async (context) => {
  const { userId, spaceId, eventId } = context.var.params;
  if (!spaceId || !eventId) return new Response("Bad Request", { status: 400 });
  const caldavUser = await requireBasicAuthUserAndAccess(context, {
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
    // Only an update needs the per-document check: a create has no document to
    // be restricted yet, and the space-level EDITOR gate above covers it.
    const documentDenied = await authorizeCalDAVDocument(
      caldavUser,
      spaceId,
      docId,
      Permission.EDITOR,
    );
    if (documentDenied) return documentDenied;

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

  const doc = await createDocument(store, caldavUser.id, event.summary, "", {
    properties: {
      title: event.summary,
      eventStart: { value: event.start, type: "date" },
      eventEnd: { value: event.end, type: "date" },
    },
  });
  return new Response(null, {
    status: 201,
    headers: {
      Location: `/api/caldav/calendars/${caldavUser.id}/${spaceId}/${doc.id}.ics`,
      ETag: `"${doc.id}"`,
      ...CORS_HEADERS,
    },
  });
});
