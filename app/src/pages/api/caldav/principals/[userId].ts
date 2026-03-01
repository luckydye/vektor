import type { APIRoute } from "astro";
import {
  optionsPreflight,
  requireCalDAVUserAndAccess,
  xmlResponse,
} from "../../../../db/caldav.ts";

/**
 * CalDAV principal endpoint.
 * Returns calendar-home-set and calendar-user-address-set for a user.
 */
export const ALL: APIRoute = async (context) => {
  if (context.request.method === "OPTIONS") return optionsPreflight();
  const { userId } = context.params;
  const caldavUser = await requireCalDAVUserAndAccess(context, { userId });
  if (caldavUser instanceof Response) return caldavUser;

  const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/api/caldav/principals/${caldavUser.id}/</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-home-set>
          <d:href>/api/caldav/calendars/${caldavUser.id}/</d:href>
        </c:calendar-home-set>
        <c:calendar-user-address-set>
          <d:href>mailto:${caldavUser.email}</d:href>
        </c:calendar-user-address-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

  return xmlResponse(body);
};
