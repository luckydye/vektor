import { afterEach, describe, expect, it } from "vitest";
import { ApiClient, type RealtimeAccessChange } from "#api/ApiClient.ts";
import {
  realtimeTopics,
  type WsMsgType as WsMessageType,
  WsMsgType,
  wsEncode,
} from "#realtime/protocol.ts";

class TestWebSocket extends EventTarget {
  static instances: TestWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly readyState = TestWebSocket.CONNECTING;
  readonly url: string;
  binaryType = "blob";

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    TestWebSocket.instances.push(this);
  }

  send(): void {}
  close(): void {}

  receive(type: WsMessageType, payload: Record<string, unknown>): void {
    const frame = wsEncode(type, payload);
    const data = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength,
    ) as ArrayBuffer;
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  TestWebSocket.instances = [];
});

describe("realtime access changes", () => {
  it("delivers decoded space and document updates to client subscribers", () => {
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
    const client = new ApiClient({ socketHost: "localhost" });
    client.subscribeToTopics("space-1", [realtimeTopics.acl], () => {});

    const received: RealtimeAccessChange[] = [];
    const unsubscribe = client.subscribeToRealtimeAccessChanges((change) => {
      received.push(change);
    });
    const socket = TestWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket?.receive(WsMsgType.AccessChanged, {
      scope: "space",
      access: "refresh",
    });
    socket?.receive(WsMsgType.AccessChanged, {
      scope: "document",
      resourceId: "document-1",
      access: "view",
    });
    socket?.receive(WsMsgType.AccessChanged, {
      scope: "document",
      resourceId: "document-1",
      access: "edit",
    });
    socket?.receive(WsMsgType.AccessChanged, {
      scope: "document",
      resourceId: "document-1",
      access: "none",
    });
    socket?.receive(WsMsgType.AccessChanged, {
      scope: "space",
      access: "none",
    });

    expect(received).toEqual([
      { spaceId: "space-1", scope: "space", access: "refresh" },
      {
        spaceId: "space-1",
        scope: "document",
        resourceId: "document-1",
        access: "view",
      },
      {
        spaceId: "space-1",
        scope: "document",
        resourceId: "document-1",
        access: "edit",
      },
      {
        spaceId: "space-1",
        scope: "document",
        resourceId: "document-1",
        access: "none",
      },
      { spaceId: "space-1", scope: "space", access: "none" },
    ]);

    unsubscribe();
    socket?.receive(WsMsgType.AccessChanged, {
      scope: "space",
      access: "refresh",
    });
    expect(received).toHaveLength(5);
  });
});
