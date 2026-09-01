import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { ApiClient } from "#api/ApiClient.ts";
import { reportJoinFailure, useCollaboration } from "#composeables/useCollaboration.ts";
import { useToast } from "#composeables/useToast.ts";
import { CollaborationJoinAbandoned } from "#editor/collaboration.ts";
import {
  type RealtimeErrorPayload,
  type WsMsgType as WsMessageType,
  WsMsgType,
  wsDecode,
  wsDecodeJson,
  wsEncode,
  wsEncodeYjsSyncRequest,
  wsEncodeYjsUpdate,
} from "#realtime/protocol.ts";

/** An open socket that records what was sent and can be fed server frames. */
class TestWebSocket extends EventTarget {
  static instances: TestWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.OPEN;
  readonly url: string;
  binaryType = "blob";
  readonly sent: Uint8Array[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    TestWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = TestWebSocket.CLOSED;
  }

  disconnect(): void {
    this.readyState = TestWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1006 }));
  }

  receive(frame: Uint8Array): void {
    const data = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength,
    ) as ArrayBuffer;
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  receiveJson(type: WsMessageType, payload: object): void {
    this.receive(wsEncode(type, payload));
  }

  /** Frames of one type sent by the client, newest last. */
  static sentFrames(type: WsMessageType): Uint8Array[] {
    return TestWebSocket.instances
      .flatMap((instance) => instance.sent)
      .map((frame) => wsDecode(frame))
      .filter((frame) => frame.type === type)
      .map((frame) => frame.payload);
  }
}

const REFUSAL: RealtimeErrorPayload = {
  message: "You do not have access to this document",
  scope: "yjs-join",
  documentId: "doc-1",
};

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  TestWebSocket.instances = [];
});

describe("a Yjs join the server refuses", () => {
  it("fails the pending join instead of leaving it to time out", () => {
    const client = new ApiClient({ socketHost: "localhost" });
    let synced = false;
    let failure: Error | null = null;
    client.joinYjsRoom(
      "space-1",
      "doc-1",
      new Y.Doc(),
      () => {
        synced = true;
      },
      (error) => {
        failure = error;
      },
    );

    TestWebSocket.instances[0]?.receiveJson(WsMsgType.Error, REFUSAL);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as unknown as Error).message).toBe(REFUSAL.message);
    expect(synced).toBe(false);
  });

  it("leaves a room that already synced alone", () => {
    const client = new ApiClient({ socketHost: "localhost" });
    const ydoc = new Y.Doc();
    let failure: Error | null = null;
    client.joinYjsRoom(
      "space-1",
      "doc-1",
      ydoc,
      () => {},
      (error) => {
        failure = error;
      },
    );

    const socket = TestWebSocket.instances[0];
    // Losing access to a joined room is announced by AccessChanged; rejecting
    // a join that already resolved would report a failure to nobody.
    socket?.receive(wsEncodeYjsUpdate("doc-1", Y.encodeStateAsUpdate(new Y.Doc())));
    socket?.receiveJson(WsMsgType.Error, {
      message: "You no longer have access to this document",
      scope: "yjs-room",
      documentId: "doc-1",
    } satisfies RealtimeErrorPayload);

    expect(failure).toBeNull();
  });

  it("fails no join when the frame names no document", () => {
    const client = new ApiClient({ socketHost: "localhost" });
    let failure: Error | null = null;
    client.joinYjsRoom(
      "space-1",
      "doc-1",
      new Y.Doc(),
      () => {},
      (error) => {
        failure = error;
      },
    );

    TestWebSocket.instances[0]?.receiveJson(WsMsgType.Error, {
      message: "Invalid message",
      scope: "frame",
      frame: "Subscribe",
    } satisfies RealtimeErrorPayload);

    expect(failure).toBeNull();
  });
});

describe("collaboration session joins", () => {
  // The composable talks to the `api` singleton, which keeps one connection per
  // space for the whole file. A space of its own gives each test a fresh socket.
  let spaces = 0;

  function session(documentId: string) {
    spaces += 1;
    return createRoot((dispose) => ({
      dispose,
      collaboration: useCollaboration({
        spaceId: `space-${spaces}`,
        documentId: () => documentId,
      }),
    }));
  }

  it("rejects with the reason the server gave", async () => {
    const { collaboration, dispose } = session("doc-1");
    try {
      const joined = collaboration.joinUntilReady();
      TestWebSocket.instances.at(-1)?.receiveJson(WsMsgType.Error, REFUSAL);
      await expect(joined).rejects.toThrow(REFUSAL.message);
    } finally {
      dispose();
    }
  });

  it("joins again after a failure rather than replaying the rejection", async () => {
    const { collaboration, dispose } = session("doc-1");
    try {
      const joined = collaboration.joinUntilReady();
      TestWebSocket.instances.at(-1)?.receiveJson(WsMsgType.Error, REFUSAL);
      await expect(joined).rejects.toThrow(REFUSAL.message);

      // Not a count: the client also replays its rooms when a socket opens, so
      // what matters is that the retry put another join on the wire at all.
      const before = TestWebSocket.sentFrames(WsMsgType.YjsJoin).length;
      const retried = collaboration.joinUntilReady();
      // Claim the rejection before asserting: a failing assertion below would
      // otherwise leave this promise floating and surface as a timeout.
      const rejected = expect(retried).rejects.toThrow(REFUSAL.message);

      const joins = TestWebSocket.sentFrames(WsMsgType.YjsJoin);
      expect(joins.length).toBe(before + 1);
      expect(wsDecodeJson<{ documentId: string }>(joins.at(-1)).documentId).toBe("doc-1");

      TestWebSocket.instances.at(-1)?.receiveJson(WsMsgType.Error, REFUSAL);
      await rejected;
    } finally {
      dispose();
    }
  });

  it("reports leaving mid-join as abandonment, not as a failure", async () => {
    const { collaboration, dispose } = session("doc-1");
    try {
      const joined = collaboration.joinUntilReady();
      collaboration.leave();
      await expect(joined).rejects.toBeInstanceOf(CollaborationJoinAbandoned);
    } finally {
      dispose();
    }
  });

  it("resolves once the server sends the room state", async () => {
    const { collaboration, dispose } = session("doc-1");
    try {
      const joined = collaboration.joinUntilReady();
      TestWebSocket.instances.at(-1)?.receiveJson(WsMsgType.YjsJoined, {
        documentId: "doc-1",
        generation: "room-generation-1",
      });
      TestWebSocket.instances
        .at(-1)
        ?.receive(wsEncodeYjsUpdate("doc-1", Y.encodeStateAsUpdate(new Y.Doc())));
      await expect(joined).resolves.toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("replaces and rejoins a stale document after an established session resets", async () => {
    const { collaboration, dispose } = session("doc-1");
    try {
      const firstDocument = collaboration.ydoc();
      const joined = collaboration.joinUntilReady();
      const socket = TestWebSocket.instances.at(-1);
      socket?.receiveJson(WsMsgType.YjsJoined, {
        documentId: "doc-1",
        generation: "room-generation-1",
      });
      socket?.receive(
        wsEncodeYjsUpdate("doc-1", Y.encodeStateAsUpdate(new Y.Doc())),
      );
      await joined;

      const joinsBeforeReset = TestWebSocket.sentFrames(WsMsgType.YjsJoin).length;
      socket?.receiveJson(WsMsgType.YjsReset, {
        documentId: "doc-1",
        generation: "room-generation-2",
      });

      await vi.waitFor(() => {
        expect(collaboration.ydoc()).not.toBe(firstDocument);
        expect(TestWebSocket.sentFrames(WsMsgType.YjsJoin).length).toBe(
          joinsBeforeReset + 1,
        );
      });

      socket?.receiveJson(WsMsgType.YjsJoined, {
        documentId: "doc-1",
        generation: "room-generation-2",
      });
      socket?.receive(
        wsEncodeYjsUpdate("doc-1", Y.encodeStateAsUpdate(new Y.Doc())),
      );
    } finally {
      dispose();
    }
  });
});

describe("reporting a join nobody is waiting on", () => {
  const { toasts, drop } = useToast();

  afterEach(() => {
    for (const toast of toasts()) drop(toast.id);
  });

  it("tells the user why, not just the console", () => {
    reportJoinFailure(new Error("You do not have access to this document"));

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]?.type).toBe("error");
    expect(toasts()[0]?.message).toContain("You do not have access to this document");
  });

  it("stays quiet when the caller left the room itself", () => {
    reportJoinFailure(new CollaborationJoinAbandoned());

    expect(toasts()).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("rejoining a room the server rebuilt from storage", () => {
  const generation = "room-generation-1";

  function docWithText(text: string): Y.Doc {
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment("default").push([paragraph]);
    return doc;
  }

  it("asks for a reset when the server reports a different room generation", () => {
    const client = new ApiClient({ socketHost: "localhost" });
    const local = docWithText("typed before the drop");
    let reset = false;
    let synced = false;
    client.joinYjsRoom(
      "space-1",
      "doc-1",
      local,
      () => {
        synced = true;
      },
      () => {},
      () => {
        reset = true;
      },
    );

    TestWebSocket.instances[0]?.receiveJson(WsMsgType.YjsReset, {
      documentId: "doc-1",
      generation: "rebuilt-room-generation",
    });

    expect(reset).toBe(true);
    expect(synced).toBe(false);
    expect(local.getXmlFragment("default").toString()).not.toContain(
      "typed before the droptyped before the drop",
    );
    expect(
      local.getXmlFragment("default").toString().split("typed before the drop").length -
        1,
    ).toBe(1);
  });

  it("syncs normally when the room is still the one this client was talking to", () => {
    const client = new ApiClient({ socketHost: "localhost" });
    const live = docWithText("shared history");
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(live), "remote");

    let reset = false;
    let synced = false;
    client.joinYjsRoom(
      "space-1",
      "doc-1",
      local,
      () => {
        synced = true;
      },
      () => {},
      () => {
        reset = true;
      },
    );

    TestWebSocket.instances[0]?.receiveJson(WsMsgType.YjsJoined, {
      documentId: "doc-1",
      generation,
    });

    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("added by a peer")]);
    live.getXmlFragment("default").push([paragraph]);
    TestWebSocket.instances[0]?.receive(
      wsEncodeYjsUpdate("doc-1", Y.encodeStateAsUpdate(live)),
    );

    expect(reset).toBe(false);
    expect(synced).toBe(true);
    expect(local.getXmlFragment("default").toString()).toContain("added by a peer");
  });

  it("does not ask a first-time join to reset", () => {
    const client = new ApiClient({ socketHost: "localhost" });
    const local = new Y.Doc();
    let reset = false;
    let synced = false;
    client.joinYjsRoom(
      "space-1",
      "doc-1",
      local,
      () => {
        synced = true;
      },
      () => {},
      () => {
        reset = true;
      },
    );

    TestWebSocket.instances[0]?.receiveJson(WsMsgType.YjsJoined, {
      documentId: "doc-1",
      generation,
    });

    TestWebSocket.instances[0]?.receive(
      wsEncodeYjsUpdate("doc-1", Y.encodeStateAsUpdate(docWithText("server content"))),
    );

    expect(reset).toBe(false);
    expect(synced).toBe(true);
    expect(local.getXmlFragment("default").toString()).toContain("server content");
  });

  it("buffers local updates until the generation and initial state are acknowledged", () => {
    const client = new ApiClient({ socketHost: "localhost" });
    const local = new Y.Doc();
    client.joinYjsRoom("space-1", "doc-1", local);

    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("typed while reconnecting")]);
    local.getXmlFragment("default").push([paragraph]);
    expect(TestWebSocket.sentFrames(WsMsgType.YjsUpdate)).toHaveLength(0);

    TestWebSocket.instances[0]?.receiveJson(WsMsgType.YjsJoined, {
      documentId: "doc-1",
      generation,
    });
    expect(TestWebSocket.sentFrames(WsMsgType.YjsUpdate)).toHaveLength(0);

    TestWebSocket.instances[0]?.receive(
      wsEncodeYjsUpdate("doc-1", Y.encodeStateAsUpdate(new Y.Doc())),
    );
    expect(TestWebSocket.sentFrames(WsMsgType.YjsUpdate)).toHaveLength(1);
  });

  it("replays the generation and flushes offline edits through the sync request", async () => {
    const client = new ApiClient({ socketHost: "localhost" });
    const local = new Y.Doc();
    const live = docWithText("shared base");
    client.joinYjsRoom("space-1", "doc-1", local);

    const firstSocket = TestWebSocket.instances[0];
    firstSocket?.receiveJson(WsMsgType.YjsJoined, {
      documentId: "doc-1",
      generation,
    });
    firstSocket?.receive(
      wsEncodeYjsUpdate("doc-1", Y.encodeStateAsUpdate(live)),
    );

    firstSocket?.disconnect();
    const offlineParagraph = new Y.XmlElement("paragraph");
    offlineParagraph.insert(0, [new Y.XmlText("offline edit")]);
    local.getXmlFragment("default").push([offlineParagraph]);
    expect(TestWebSocket.sentFrames(WsMsgType.YjsUpdate)).toHaveLength(0);

    (
      client as unknown as {
        reconnectRealtimeNow(): void;
      }
    ).reconnectRealtimeNow();
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(2));
    await Promise.resolve();

    const reconnectJoin = wsDecodeJson<{
      generation?: string;
      stateVector?: string;
    }>(TestWebSocket.sentFrames(WsMsgType.YjsJoin).at(-1) as Uint8Array);
    expect(reconnectJoin.generation).toBe(generation);
    expect(reconnectJoin.stateVector).toBeTypeOf("string");

    const secondSocket = TestWebSocket.instances[1];
    secondSocket?.receiveJson(WsMsgType.YjsJoined, {
      documentId: "doc-1",
      generation,
    });
    secondSocket?.receive(
      wsEncodeYjsUpdate("doc-1", Y.encodeStateAsUpdate(live, Y.encodeStateVector(local))),
    );
    expect(TestWebSocket.sentFrames(WsMsgType.YjsUpdate)).toHaveLength(0);

    secondSocket?.receive(
      wsEncodeYjsSyncRequest("doc-1", Y.encodeStateVector(live)),
    );
    expect(TestWebSocket.sentFrames(WsMsgType.YjsUpdate)).toHaveLength(1);
  });
});
