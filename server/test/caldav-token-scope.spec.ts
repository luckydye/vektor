/**
 * CalDAV Basic auth must honour the access token's scope.
 *
 * A CalDAV client authenticates with `Basic <email:access_token>`. The token is
 * a *delegation*: it names one space and one role. These specs pin that the
 * CalDAV routes authorize against the token's grant and not against the ACL of
 * the user who created it — otherwise handing a "viewer on space A" token to a
 * calendar app hands over the whole account.
 *
 * Runs against a real email-auth server (not `VEKTOR_NO_AUTH`, which short-
 * circuits Basic auth to the local user and never reaches a token).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  type TestUserSession,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7493;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let owner: TestUserSession;

/** Space the tokens under test are scoped to. */
let spaceA: string;
/** A second space the same user owns — reachable by the user, never by an A token. */
let spaceB: string;
let docA: string;
let docB: string;

/** Space-level grants in space A, created fresh so no spec depends on another. */
let viewerToken: string;
let editorToken: string;
let revokedToken: { id: string; token: string };

function basicAuth(token: string): string {
  return `Basic ${btoa(`${owner.email}:${token}`)}`;
}

/** A CalDAV request as an external client makes it: Basic auth, no cookie. */
function calDav(
  path: string,
  method: string,
  token: string,
  body?: string,
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: basicAuth(token),
      ...(body ? { "Content-Type": "text/calendar" } : {}),
    },
    body,
  });
}

function calendarPath(spaceId: string): string {
  return `/api/caldav/calendars/${owner.userId}/${spaceId}`;
}

function eventPath(spaceId: string, documentId: string): string {
  return `${calendarPath(spaceId)}/${documentId}.ics`;
}

function icalEvent(summary: string): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:scope-test",
    "DTSTAMP:20260701T120000Z",
    "DTSTART:20260701T120000Z",
    "DTEND:20260701T130000Z",
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

async function createSpace(name: string, slug: string): Promise<string> {
  const response = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({ name, slug }),
  });
  if (!response.ok) throw new Error(`Failed to create space: ${response.status}`);
  return (await response.json()).space.id;
}

async function createEventDocument(spaceId: string, title: string): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, owner.token, {
    method: "POST",
    body: JSON.stringify({
      content: `<p>${title}</p>`,
      properties: {
        title,
        eventStart: "2026-06-13T00:00:00Z",
        eventEnd: "2026-06-14T00:00:00Z",
      },
    }),
  });
  if (!response.ok) throw new Error(`Failed to create document: ${response.status}`);
  return (await response.json()).document.id;
}

/** Create an access token in `spaceId` granting `permission` on the space itself. */
async function createSpaceToken(
  spaceId: string,
  name: string,
  permission: "viewer" | "editor",
): Promise<{ id: string; token: string }> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/access-tokens`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        permission,
        resourceType: "space",
        resourceId: spaceId,
      }),
    },
  );
  if (!response.ok) throw new Error(`Failed to create token: ${response.status}`);
  const body = await response.json();
  return { id: body.id, token: body.token };
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "caldav-scope-test-secret-do-not-use",
  });
  await waitForServer(BASE_URL);

  owner = await createTestUser(BASE_URL, "CalDAV Scope Owner", "test-caldav-scope");

  spaceA = await createSpace("Scope Space A", "scope-space-a");
  spaceB = await createSpace("Scope Space B", "scope-space-b");
  docA = await createEventDocument(spaceA, "Event In A");
  docB = await createEventDocument(spaceB, "Event In B");

  viewerToken = (await createSpaceToken(spaceA, "scope-viewer", "viewer")).token;
  editorToken = (await createSpaceToken(spaceA, "scope-editor", "editor")).token;
  revokedToken = await createSpaceToken(spaceA, "scope-revoked", "viewer");
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("CalDAV token scope", () => {
  it("lets a viewer-scoped token read its own space", async () => {
    const propfind = await calDav(`${calendarPath(spaceA)}/`, "PROPFIND", viewerToken);
    expect(propfind.status).toBe(207);

    const report = await calDav(`${calendarPath(spaceA)}/`, "REPORT", viewerToken);
    expect(report.status).toBe(207);
    expect(await report.text()).toContain("Event In A");
  });

  it("refuses a space-A token access to space B", async () => {
    // The user owns space B, so the pre-fix code authorized this via the user's
    // ACL and served B's events to a token scoped to A.
    expect(
      (await calDav(`${calendarPath(spaceB)}/`, "PROPFIND", viewerToken)).status,
    ).toBe(403);
    expect((await calDav(`${calendarPath(spaceB)}/`, "REPORT", viewerToken)).status).toBe(
      403,
    );
    expect((await calDav(eventPath(spaceB, docB), "GET", viewerToken)).status).toBe(403);
    expect(
      (await calDav(eventPath(spaceB, docB), "PUT", editorToken, icalEvent("Injected")))
        .status,
    ).toBe(403);
  });

  it("does not leak other spaces in the calendar home of a scoped token", async () => {
    const response = await calDav(
      `/api/caldav/calendars/${owner.userId}/`,
      "PROPFIND",
      viewerToken,
    );
    expect(response.status).toBe(207);
    const body = await response.text();
    expect(body).toContain(spaceA);
    expect(body).not.toContain(spaceB);
    expect(body).not.toContain("Scope Space B");
  });

  it("refuses a PUT to a viewer-scoped token but allows the read", async () => {
    expect((await calDav(eventPath(spaceA, docA), "GET", viewerToken)).status).toBe(200);
    expect(
      (
        await calDav(
          eventPath(spaceA, docA),
          "PUT",
          viewerToken,
          icalEvent("Viewer Wrote"),
        )
      ).status,
    ).toBe(403);

    // The refused write must not have landed.
    const ical = await (await calDav(eventPath(spaceA, docA), "GET", viewerToken)).text();
    expect(ical).not.toContain("Viewer Wrote");
  });

  it("allows a PUT with an editor-scoped token", async () => {
    const response = await calDav(
      eventPath(spaceA, docA),
      "PUT",
      editorToken,
      icalEvent("Editor Wrote"),
    );
    expect(response.status).toBe(204);

    const ical = await (await calDav(eventPath(spaceA, docA), "GET", editorToken)).text();
    expect(ical).toContain("Editor Wrote");
  });

  it("loses CalDAV access when the token itself is revoked", async () => {
    expect(
      (await calDav(`${calendarPath(spaceA)}/`, "REPORT", revokedToken.token)).status,
    ).toBe(207);

    const revoke = await apiRequest(
      `/api/v1/spaces/${spaceA}/access-tokens/${revokedToken.id}`,
      owner.token,
      { method: "PATCH" },
    );
    expect(revoke.ok).toBe(true);

    // The credential no longer authenticates at all — neither the calendar it
    // was scoped to nor the calendar home.
    expect(
      (await calDav(`${calendarPath(spaceA)}/`, "REPORT", revokedToken.token)).status,
    ).toBe(401);
    expect(
      (
        await calDav(
          `/api/caldav/calendars/${owner.userId}/`,
          "PROPFIND",
          revokedToken.token,
        )
      ).status,
    ).toBe(401);
  });

  it("rejects a token that is not an access token at all", async () => {
    expect(
      (await calDav(`${calendarPath(spaceA)}/`, "REPORT", "at_not-a-real-token")).status,
    ).toBe(401);
  });

  it("keeps session-authenticated CalDAV on the user's own access", async () => {
    // The session path legitimately uses the user's ACL: the owner reaches both
    // of their spaces, including the one no token is scoped to.
    for (const spaceId of [spaceA, spaceB]) {
      const response = await fetch(`${BASE_URL}${calendarPath(spaceId)}/`, {
        method: "REPORT",
        headers: { Cookie: `vektor.session_token=${owner.token}` },
      });
      expect(response.status).toBe(207);
    }

    const home = await fetch(`${BASE_URL}/api/caldav/calendars/${owner.userId}/`, {
      method: "PROPFIND",
      headers: { Cookie: `vektor.session_token=${owner.token}` },
    });
    expect(home.status).toBe(207);
    const body = await home.text();
    expect(body).toContain(spaceA);
    expect(body).toContain(spaceB);
  });
});
