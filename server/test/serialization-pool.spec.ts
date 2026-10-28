import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { contentFromDoc } from "#documents/serialization.ts";
import { poolDocSerializer, stopSerializationPool } from "#platform/bun/serializationPool.ts";

afterAll(() => stopSerializationPool());

describe("serialization pool", () => {
  it("round-trips HTML content through a worker", async () => {
    const html = "<h1>Title</h1>\n<p>one</p>\n<p>two</p>";
    const doc = await poolDocSerializer.deserialize("html", html);
    expect(doc.getXmlFragment("default").length).toBe(3);
    const out = await poolDocSerializer.serialize("html", doc);
    expect(out).toBe(html);
  });

  it("matches in-process serialization byte-for-byte", async () => {
    // The worker and the main thread share documents/serialization, so content
    // stored by either reads back identically through the other.
    const html = "<h1>Pooled</h1>\n<p>body</p>";
    const doc = await poolDocSerializer.deserialize("html", html);
    const viaPool = await poolDocSerializer.serialize("html", doc);
    const inProcess = contentFromDoc("html", doc);
    expect(viaPool).toBe(inProcess);
    expect(viaPool).toBe(html);
  });

  it("keeps the live Y.Doc on the main thread (worker only sees binary)", async () => {
    // A doc built here, serialized via the pool, must survive the binary
    // round-trip that ships it to the worker and back as content.
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("live text")]);
    fragment.push([para]);
    const out = await poolDocSerializer.serialize("html", doc);
    expect(out).toContain("live text");
  });
});
