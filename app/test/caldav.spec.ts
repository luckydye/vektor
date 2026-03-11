import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { CalDAVSource } from "./caldav/caldav-client.ts";

const DATA_DIR = "./data";
const AUTH_DB_PATH = join(DATA_DIR, "auth.db");
const BASE_URL = "http://127.0.0.1:4321";

let testUser: { id: string; email: string; name: string };
let sessionToken: string;
let testSpaceId: string;
let testAccessToken: string;

async function createTestUser() {
  const testEmail = `caldav-test-${Date.now()}@example.com`;

  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: testEmail,
      password: "TestPassword123!",
      name: "CalDAV Test User",
    }),
  });

  if (!response.ok) throw new Error(`Failed to create test user: ${response.statusText}`);

  const data = await response.json();
  const cookies = response.headers.get("set-cookie");
  let sessionCookie = data.token;
  if (cookies) {
    const match = cookies.match(/better-auth\.session_token=([^;]+)/);
    if (match) sessionCookie = match[1];
  }

  return {
    userId: data.user.id,
    token: sessionCookie,
    email: testEmail,
    name: data.user.name,
  };
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (sessionToken) headers.set("Cookie", `better-auth.session_token=${sessionToken}`);
  headers.set("Content-Type", "application/json");
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

function createCalDAVSource() {
  return new CalDAVSource("test-caldav", "Test Calendar", "#FF6E68", {
    serverUrl: BASE_URL,
    username: testUser.email,
    password: testAccessToken,
  });
}

beforeAll(async () => {
  const { userId, token, email, name } = await createTestUser();
  testUser = { id: userId, email, name };
  sessionToken = token;

  const spaceResp = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({
      name: "CalDAV Test Space",
      slug: `caldav-test-${Date.now()}`,
    }),
  });
  if (!spaceResp.ok) throw new Error(`Failed to create space: ${spaceResp.statusText}`);
  const spaceBody = await spaceResp.json();
  expect(spaceBody.space.id).toStartWith("space_");
  testSpaceId = spaceBody.space.id;

  const tokenResp = await apiRequest(`/api/v1/spaces/${testSpaceId}/access-tokens`, {
    method: "POST",
    body: JSON.stringify({
      name: "CalDAV Test Token",
      resourceType: "space",
      resourceId: testSpaceId,
      permission: "viewer",
    }),
  });
  if (!tokenResp.ok)
    throw new Error(`Failed to create access token: ${tokenResp.statusText}`);
  const tokenBody = await tokenResp.json();
  expect(tokenBody.id).toStartWith("token_");
  testAccessToken = tokenBody.token;

  const doc1 = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      content: "<p>First test document</p>",
      properties: { title: "Test Document 1" },
    }),
  });
  if (!doc1.ok) throw new Error(`Failed to create doc1: ${doc1.statusText}`);

  const doc2 = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      content: "<p>Second test document</p>",
      properties: { title: "Test Document 2" },
    }),
  });
  if (!doc2.ok) throw new Error(`Failed to create doc2: ${doc2.statusText}`);
});

afterAll(async () => {
  if (testSpaceId && existsSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`))) {
    rmSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`), { force: true });
  }

  if (testUser?.id && existsSync(AUTH_DB_PATH)) {
    try {
      const authSqlite = new Database(AUTH_DB_PATH);
      const authDb = drizzle({ client: authSqlite });
      await authDb.run(sql`DELETE FROM account WHERE user_id = ${testUser.id}`);
      await authDb.run(sql`DELETE FROM session WHERE user_id = ${testUser.id}`);
      await authDb.run(sql`DELETE FROM user WHERE id = ${testUser.id}`);
      authSqlite.close();
    } catch (error) {
      console.log("CalDAV test cleanup error:", error);
    }
  }
});

describe("CalDAV API", () => {
  it("should connect successfully with a valid access token", async () => {
    const client = createCalDAVSource();
    expect(await client.testConnection()).toBe(true);
  });

  it("should reject an invalid access token", async () => {
    const badClient = new CalDAVSource("bad-caldav", "Bad Calendar", "#000000", {
      serverUrl: BASE_URL,
      username: testUser.email,
      password: "at_invalidtoken",
    });
    expect(await badClient.testConnection()).toBe(false);
  });

  it("should return the current user email", async () => {
    const client = createCalDAVSource();
    expect(await client.fetchCurrentUserEmail()).toBe(testUser.email);
  });

  it("should list calendars including the test space", async () => {
    const client = createCalDAVSource();
    const calendars = await client.fetchCalendars();

    expect(calendars.length).toBeGreaterThan(0);
    const testCalendar = calendars.find((c) => c.url.includes(testSpaceId));
    expect(testCalendar).toBeDefined();
    expect(testCalendar!.displayName).toBe("CalDAV Test Space");
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
