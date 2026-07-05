import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CalDAVSource } from "./caldav/caldav-client.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7483;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

const LOCAL_USER_EMAIL = "local@localhost";

let testSpaceId: string;
let serverProcess: TestServerProcess;

function createCalDAVSource() {
  return new CalDAVSource("test-caldav", "Test Calendar", "#FF6E68", {
    serverUrl: BASE_URL,
    username: LOCAL_USER_EMAIL,
    password: "noauth",
  });
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
    VEKTOR_NO_AUTH: "1",
  });

  await waitForServer(BASE_URL);

  const spaceResp = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({
      name: "CalDAV Test Space",
      slug: "caldav-test",
    }),
  });
  if (!spaceResp.ok) throw new Error(`Failed to create space: ${spaceResp.statusText}`);
  const spaceBody = await spaceResp.json();
  expect(spaceBody.space.id).toStartWith("space_");
  testSpaceId = spaceBody.space.id;

  const doc1 = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      content: "<p>First test document</p>",
      properties: {
        title: "Test Document 1",
        eventStart: "2026-06-13T00:00:00Z",
        eventEnd: "2026-06-14T00:00:00Z",
      },
    }),
  });
  if (!doc1.ok) throw new Error(`Failed to create doc1: ${doc1.statusText}`);

  const doc2 = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      content: "<p>Second test document</p>",
      properties: {
        title: "Test Document 2",
        eventStart: "2026-06-20T00:00:00Z",
        eventEnd: "2026-06-21T00:00:00Z",
      },
    }),
  });
  if (!doc2.ok) throw new Error(`Failed to create doc2: ${doc2.statusText}`);
}, 30_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("CalDAV API", () => {
  it("should connect successfully", async () => {
    const client = createCalDAVSource();
    expect(await client.testConnection()).toBe(true);
  });

  it("should return the local user email", async () => {
    const client = createCalDAVSource();
    expect(await client.fetchCurrentUserEmail()).toBe(LOCAL_USER_EMAIL);
  });

  it("should list calendars including the test space", async () => {
    const client = createCalDAVSource();
    const calendars = await client.fetchCalendars();

    expect(calendars.length).toBeGreaterThan(0);
    const testCalendar = calendars.find((c) => c.url.includes(testSpaceId));
    expect(testCalendar).toBeDefined();
    expect(testCalendar?.displayName).toBe("CalDAV Test Space");
  });

  it("should fetch events from a specific calendar", async () => {
    const client = createCalDAVSource();
    const calendars = await client.fetchCalendars();
    const testCalendar = calendars.find((c) => c.url.includes(testSpaceId))!;

    const events = await client.fetchEventsForCalendar(
      testCalendar.url,
      testCalendar.displayName,
      testCalendar.color,
    );

    expect(events.length).toBeGreaterThanOrEqual(2);
    const titles = events.map((e) => e.title);
    expect(titles).toContain("Test Document 1");
    expect(titles).toContain("Test Document 2");
  });

  it("should fetch all events across all calendars", async () => {
    const client = createCalDAVSource();
    const events = await client.fetchEvents();

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.find((e) => e.title === "Test Document 1")).toBeDefined();
    expect(events.find((e) => e.title === "Test Document 2")).toBeDefined();
  });

  it("should return all-day events with valid date range", async () => {
    const client = createCalDAVSource();
    const calendars = await client.fetchCalendars();
    const testCalendar = calendars.find((c) => c.url.includes(testSpaceId))!;

    const events = await client.fetchEventsForCalendar(
      testCalendar.url,
      testCalendar.displayName,
      testCalendar.color,
    );

    for (const event of events) {
      expect(event.isAllDay).toBe(true);
      expect(event.start).toBeInstanceOf(Date);
      expect(event.end).toBeInstanceOf(Date);
      expect(event.end.getTime()).toBeGreaterThan(event.start.getTime());
    }
  });

  it("should serve a single document as an ical file", async () => {
    const client = createCalDAVSource();
    const calendars = await client.fetchCalendars();
    const testCalendar = calendars.find((c) => c.url.includes(testSpaceId))!;

    const events = await client.fetchEventsForCalendar(
      testCalendar.url,
      testCalendar.displayName,
      testCalendar.color,
    );
    const event = events.find((e) => e.title === "Test Document 1")!;
    expect(event).toBeDefined();

    const icsUrl = `${testCalendar.url.replace(/\/$/, "")}/${event.id}.ics`;
    const response = await client.request(icsUrl, "GET", undefined, {
      Accept: "text/calendar",
    });
    expect(response.ok).toBe(true);
    const icalText = await response.text();
    expect(icalText).toContain("BEGIN:VCALENDAR");
    expect(icalText).toContain("BEGIN:VEVENT");
    expect(icalText).toContain("Test Document 1");
  });
});
