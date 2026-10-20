import {
  caldavRoute,
  calendarEntry,
  escapeXml,
  listsChildren,
  optionsPreflight,
  requireBasicAuthUserAndAccess,
  requireCalendarSpace,
  xmlResponse,
} from "#api/caldav.ts";
import { requireParam } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

/**
 * Advertise the methods the principal supports.
 *
 * @method OPTIONS
 * @tag CalDAV
 * @param spaceId The space this principal serves, which an access token is checked in; the principal is also its calendar home.
 * @note The CalDAV principal: returns calendar-home-set and calendar-user-address-set for a user; a WebDAV PROPFIND with Depth 1 lists it as the calendar home holding the space's calendar.
 */
export const ALL: ApiRouteHandler = caldavRoute(async (context) => {
  if (context.req.raw.method === "OPTIONS") return optionsPreflight();
  const userId = context.var.params.userId;
  const spaceId = requireParam(context.var.params, "spaceId");
  const caldavUser = await requireBasicAuthUserAndAccess(context, { userId, spaceId });
  if (caldavUser instanceof Response) return caldavUser;

  // The principal is its own calendar home, as in Radicale: a token only
  // authenticates where its URL names its space.
  const self = `/api/caldav/principals/${caldavUser.id}/${spaceId}/`;
  const asHome = listsChildren(context);
  const calendars = asHome
    ? calendarEntry(
        caldavUser.id,
        await requireCalendarSpace(context.var.platform, spaceId),
      )
    : "";
  // Listed as a home, it answers as the old calendar home did: its own entry
  // carries no calendar props, so clients take only the child for a calendar.
  const principalProps = asHome
    ? ""
    : `
        <d:current-user-principal>
          <d:href>${self}</d:href>
        </d:current-user-principal>
        <c:calendar-home-set>
          <d:href>${self}</d:href>
        </c:calendar-home-set>
        <c:calendar-user-address-set>
          <d:href>mailto:${escapeXml(caldavUser.email)}</d:href>
        </c:calendar-user-address-set>`;

  const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:apple="http://apple.com/ns/ical/">
  <d:response>
    <d:href>${self}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><d:principal/></d:resourcetype>${principalProps}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
${calendars}
</d:multistatus>`;

  return xmlResponse(body);
});
