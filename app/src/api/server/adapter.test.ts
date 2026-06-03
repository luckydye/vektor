import { afterEach, describe, expect, it } from "bun:test";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";

const originalNoAuth = process.env.VEKTOR_NO_AUTH;

afterEach(() => {
  if (originalNoAuth === undefined) {
    delete process.env.VEKTOR_NO_AUTH;
  } else {
    process.env.VEKTOR_NO_AUTH = originalNoAuth;
  }
});

function createRequest(body: string): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  req.method = "POST";
  req.url = "/api/v1/chat/acp";
  req.headers = {
    host: "localhost:4321",
    "content-type": "application/json",
  };
  req.socket = {} as IncomingMessage["socket"];

  queueMicrotask(() => {
    req.end(body);
  });

  return req;
}

describe("buildApiContext", () => {
  it("does not abort the request signal on normal request close", async () => {
    process.env.VEKTOR_NO_AUTH = "1";
    const { buildApiContext } = await import("./adapter.ts");
    const req = createRequest(JSON.stringify({ ok: true }));

    req.once("end", () => req.emit("close"));

    const context = await buildApiContext(req, {});

    expect(context.request.signal.aborted).toBe(false);
    expect(await context.request.json()).toEqual({ ok: true });
  });

  it("aborts the request signal when the incoming request is aborted", async () => {
    process.env.VEKTOR_NO_AUTH = "1";
    const { buildApiContext } = await import("./adapter.ts");
    const req = createRequest(JSON.stringify({ ok: true }));

    req.once("end", () => req.emit("aborted"));

    const context = await buildApiContext(req, {});

    expect(context.request.signal.aborted).toBe(true);
  });
});
