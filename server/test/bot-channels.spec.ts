import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobToken } from "#jobs/jobToken.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

process.env.AUTH_SECRET ??= "bot-channels-test-secret-do-not-use-in-production";

const PORT = 7580;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let spaceId: string;

async function acp(method: string, params: Record<string, unknown>): Promise<Response> {
  return await apiRequest("/api/v1/chat/acp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { spaceId, ...params } }),
  });
}

async function newSession(params: Record<string, unknown>): Promise<string> {
  const response = await acp("session/new", params);
  expect(response.status).toBe(200);
  return (await response.json()).result.sessionId;
}

/** Posts and reads the round's stream to its end. */
async function post(sessionId: string, text: string): Promise<string> {
  const response = await acp("session/prompt", { sessionId, prompt: [{ text }] });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return await response.text();
}

async function messages(sessionId: string) {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/chat/sessions/${sessionId}/messages`,
  );
  expect(response.status).toBe(200);
  return (await response.json()).messages as Array<{
    seq: number;
    role: string;
    authorId: string | null;
    content: string;
  }>;
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
  });
  await waitForServer(BASE_URL);

  const response = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Bots", slug: "bots" }),
  });
  expect(response.status).toBe(201);
  spaceId = (await response.json()).space.id;
});

afterAll(() => {
  serverProcess?.kill();
});

describe("bot channels", () => {
  it("lists channels, never private sessions", async () => {
    const channelId = await newSession({
      visibility: "space",
      title: "Release bot",
      avatar: "🚀",
      rolePrompt: "You write release notes.",
    });
    await newSession({ title: "My private chat" });

    const response = await apiRequest(`/api/v1/spaces/${spaceId}/chat/sessions`);
    const { sessions } = await response.json();
    const titles = sessions.map((session: { title: string }) => session.title);
    expect(titles).toContain("Release bot");
    expect(titles).not.toContain("My private chat");
    expect(sessions.find((s: { id: string }) => s.id === channelId)).toMatchObject({
      visibility: "space",
      access: "editor",
      avatar: "🚀",
      rolePrompt: "You write release notes.",
      threadCount: 0,
      running: false,
    });
  });

  it("answers every post, and logs it as the poster", async () => {
    const channelId = await newSession({ visibility: "space", title: "Answering bot" });
    const stream = await post(channelId, "Hello bot");
    expect(stream).toContain("data: [DONE]");

    const rows = await messages(channelId);
    expect(rows[0]).toMatchObject({ role: "user", content: "Hello bot" });
    expect(rows[0].authorId).toBeTruthy();
    // The round wrote its answer, or the error that stopped it, after the post.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.at(-1)?.role).toBe("assistant");
  });

  it("runs as its own principal, with the access it was given", async () => {
    const channelId = await newSession({
      visibility: "space",
      title: "Reader",
      access: "viewer",
    });
    const token = createJobToken(spaceId, Date.now().toString(), `bot:${channelId}`, {
      app: "agent",
    });
    const asBot = (path: string, init: RequestInit = {}) =>
      fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", "X-Job-Token": token },
      });

    expect((await asBot(`/api/v1/spaces/${spaceId}/documents`)).status).toBe(200);
    const write = await asBot(`/api/v1/spaces/${spaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({ content: "<p>x</p>", properties: { title: "x" } }),
    });
    expect(write.status).toBe(403);

    // Raising its access raises what it may do.
    const patched = await apiRequest(`/api/v1/spaces/${spaceId}/chat/sessions/${channelId}`, {
      method: "PATCH",
      body: JSON.stringify({ access: "editor" }),
    });
    expect(patched.status).toBe(200);
    const retried = await asBot(`/api/v1/spaces/${spaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({ content: "<p>x</p>", properties: { title: "x" } }),
    });
    expect(retried.status).toBe(201);
  });

  it("takes events from services: quiet ones wait, waking ones are answered", async () => {
    const channelId = await newSession({ visibility: "space", title: "Event bot" });
    const postEvent = (body: Record<string, unknown>) =>
      apiRequest(`/api/v1/spaces/${spaceId}/chat/sessions/${channelId}/events`, {
        method: "POST",
        body: JSON.stringify(body),
      });

    expect((await postEvent({ source: "not a source!", text: "x" })).status).toBe(400);

    const quiet = await postEvent({
      source: "github",
      text: "PR #12 opened",
      data: { pr: 12 },
      wake: false,
    });
    expect(quiet.status).toBe(200);
    // Nothing answers a quiet event.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await messages(channelId)).toMatchObject([
      { role: "user", authorId: "event:github", content: "PR #12 opened" },
    ]);

    const waking = await postEvent({ source: "github", text: "CI failed on main" });
    expect(waking.status).toBe(200);
    const { seq } = await waking.json();
    let rows = await messages(channelId);
    for (let tries = 0; tries < 60 && !rows.some((row) => row.seq > seq); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      rows = await messages(channelId);
    }
    // The round answered both, the quiet one with it.
    expect(rows.find((row) => row.seq > seq)?.role).toBe("assistant");
  });

  it("threads reply to one channel message, and go with the channel", async () => {
    const channelId = await newSession({ visibility: "space", title: "Threaded bot" });
    await post(channelId, "Root message");
    const [root] = await messages(channelId);

    const threadId = await newSession({
      visibility: "space",
      parentSessionId: channelId,
      threadRootSeq: root.seq,
    });
    // Replying again continues the same thread.
    expect(
      await newSession({ visibility: "space", parentSessionId: channelId, threadRootSeq: root.seq }),
    ).toBe(threadId);
    // One level deep.
    const nested = await acp("session/new", {
      visibility: "space",
      parentSessionId: threadId,
      threadRootSeq: root.seq,
    });
    expect(nested.status).toBe(400);

    await post(threadId, "In the thread");
    const threads = await apiRequest(
      `/api/v1/spaces/${spaceId}/chat/sessions?parent=${channelId}`,
    );
    const { sessions } = await threads.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: threadId,
      title: "Root message",
      threadRootSeq: root.seq,
    });
    expect(sessions[0].messageCount).toBeGreaterThan(0);

    const deleted = await apiRequest(`/api/v1/spaces/${spaceId}/chat/sessions/${channelId}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const gone = await apiRequest(`/api/v1/spaces/${spaceId}/chat/sessions/${threadId}`);
    expect(gone.status).toBe(404);
  });
});
