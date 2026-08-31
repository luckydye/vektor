import {
  calDavUnauthorized,
  optionsPreflight,
  verifyBasicAuth,
  xmlResponse,
} from "#api/caldav.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

/**
 * Advertise CalDAV support.
 *
 * @method OPTIONS
 * @tag CalDAV
 * @public
 * @note CalDAV service discovery. Also answers the WebDAV methods (PROPFIND) that OpenAPI cannot describe — `curl -X PROPFIND -u user@example.com:password http://localhost:4321/.well-known/caldav`.
 */
export const ALL: ApiRouteHandler = async (context) => {
  if (context.req.raw.method === "OPTIONS") return optionsPreflight();
  const caldavUser = await verifyBasicAuth(context.req.raw.headers.get("Authorization"));
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
