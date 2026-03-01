import type { APIRoute } from "astro";
import {
  optionsPreflight,
  requireCalDAVUserAndAccess,
  xmlResponse,
} from "../../../../../db/caldav.ts";
import { listUserSpaces } from "../../../../../db/spaces.ts";

/**
 * CalDAV calendar home endpoint.
 * Lists all spaces accessible to the user as CalDAV calendars.
 * Responds to PROPFIND with Depth: 1.
 */
export const ALL: APIRoute = async (context) => {
  if (context.request.method === "OPTIONS") return optionsPreflight();
  const { userId } = context.params;
  const caldavUser = await requireCalDAVUserAndAccess(context, { userId });
  if (caldavUser instanceof Response) return caldavUser;

  const spaces = await listUserSpaces(caldavUser.id);

  const calendarEntries = spaces
    .map(
      (space) => `  <d:response>
    <d:href>/api/caldav/calendars/${caldavUser.id}/${space.id}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>${space.name}</d:displayname>
        <cs:getctag>${space.updatedAt.getTime()}</cs:getctag>
        <apple:calendar-color>${space.preferences.brandColor || "#1e293b"}</apple:calendar-color>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`,
    )
    .join("\n");

  const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:apple="http://apple.com/ns/ical/">
  <d:response>
    <d:href>/api/caldav/calendars/${caldavUser.id}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
${calendarEntries}
</d:multistatus>`;

  return xmlResponse(body);
};
