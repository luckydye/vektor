import type { APIRoute } from "astro";
import {
  calDavUnauthorized,
  optionsPreflight,
  verifyBasicAuth,
  xmlResponse,
} from "../../db/caldav.ts";

/**
 * CalDAV well-known discovery endpoint.
 * Responds to PROPFIND with the current-user-principal URL.
 *
 * @example
 * curl -X PROPFIND -u user@example.com:password http://localhost:4321/.well-known/caldav
 */
export const ALL: APIRoute = async (context) => {
  if (context.request.method === "OPTIONS") return optionsPreflight();
  const caldavUser = await verifyBasicAuth(context.request.headers.get("Authorization"));
  if (!caldavUser) return calDavUnauthorized();

  const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/.well-known/caldav</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal>
          <d:href>/api/caldav/principals/${caldavUser.id}/</d:href>
        </d:current-user-principal>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

  return xmlResponse(body);
};
