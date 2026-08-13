import {
  escapeXml,
  optionsPreflight,
  requireCalDAVUserAndAccess,
  xmlResponse,
} from "#api/caldav.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { listUserSpaces } from "#db/space/spaces.ts";

/**
 * CalDAV calendar home endpoint.
 * Lists all spaces accessible to the user as CalDAV calendars.
 * Responds to PROPFIND with Depth: 1.
 */
export const ALL: ApiRouteHandler = async (context) => {
  if (context.req.raw.method === "OPTIONS") return optionsPreflight();
  const { userId } = context.var.params;
  const caldavUser = await requireCalDAVUserAndAccess(context, { userId });
  if (caldavUser instanceof Response) return caldavUser;

  const spaces = await listUserSpaces(caldavUser.id);

  // A caller authenticated with an access token is confined to that token's
  // space, so the calendar home must not advertise the user's other spaces —
  // their names and ids are outside the token's scope just as their events are.
  const tokenSpaceId = caldavUser.token?.spaceId;
  const visibleSpaces = tokenSpaceId
    ? spaces.filter((space) => space.id === tokenSpaceId)
    : spaces;

  const calendarEntries = visibleSpaces
    .map(
      (space) => `  <d:response>
    <d:href>/api/caldav/calendars/${caldavUser.id}/${space.id}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>${escapeXml(space.name)}</d:displayname>
        <cs:getctag>${space.updatedAt.getTime()}</cs:getctag>
        <apple:calendar-color>${escapeXml(space.preferences.brandColor || "#1e293b")}</apple:calendar-color>
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
