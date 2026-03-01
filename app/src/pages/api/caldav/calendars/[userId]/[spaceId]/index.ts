import type { APIRoute } from "astro";
import {
  documentToICal,
  optionsPreflight,
  requireCalDAVUserAndAccess,
  xmlResponse,
} from "../../../../../../db/caldav.ts";
import { listDocuments } from "../../../../../../db/documents.ts";

/**
 * CalDAV calendar endpoint for a specific space.
 * - PROPFIND: returns calendar metadata
 * - REPORT: returns all documents as VEVENT iCal data
 */
export const ALL: APIRoute = async (context) => {
  if (context.request.method === "OPTIONS") return optionsPreflight();
  const { userId, spaceId } = context.params;
  const caldavUser = await requireCalDAVUserAndAccess(context, { userId, spaceId });
  if (caldavUser instanceof Response) return caldavUser;

  const method = context.request.method.toUpperCase();

  if (method === "REPORT") {
    const { documents } = await listDocuments(spaceId);

    const eventEntries = documents
      .flatMap((doc) => {
        const icalData = documentToICal(doc);
        if (!icalData) return [];
        const escaped = icalData
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        return [
          `  <d:response>
    <d:href>/api/caldav/calendars/${caldavUser.id}/${spaceId}/${doc.id}.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"${doc.id}"</d:getetag>
        <c:calendar-data>${escaped}</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`,
        ];
      })
      .join("\n");

    const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
${eventEntries}
</d:multistatus>`;

    return xmlResponse(body);
  }

  if (method === "PROPFIND") {
    const { total } = await listDocuments(spaceId);

    const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>/api/caldav/calendars/${caldavUser.id}/${spaceId}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <cs:getctag>${total}</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    return xmlResponse(body);
  }

  return new Response("Method Not Allowed", { status: 405 });
};
