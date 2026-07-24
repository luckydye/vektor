import { afterAll, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { contentFromDoc } from "#utils/serializationCore.ts";
import {
  deserializeDocContent,
  serializeDocContent,
  stopSerializationPool,
} from "#utils/serializationPool.ts";

afterAll(() => stopSerializationPool());

describe("serialization pool", () => {
  it("round-trips HTML content through a worker", async () => {
    const html = "<h1>Title</h1>\n<p>one</p>\n<p>two</p>";
    const doc = await deserializeDocContent("space_a", "doc_a", null, html);
    expect(doc.getXmlFragment("default").length).toBe(3);
    const out = await serializeDocContent("space_a", "doc_a", null, doc);
    expect(out).toBe(html);
  });

  it("round-trips canvas snapshots through a worker", async () => {
    const snapshot = JSON.stringify({
      version: 1,
      shapes: [
        {
          id: "s1",
          type: "note",
          frame: { x: 10, y: 20, width: 240, height: 150, rotation: 0 },
          style: { color: "#fef3c7" },
          data: { text: "hi" },
          updatedAt: 1,
        },
      ],
      strokes: [],
    });
    const doc = await deserializeDocContent("space_a", "doc_c", "canvas", snapshot);
    const out = await serializeDocContent("space_a", "doc_c", "canvas", doc);
    const parsed = JSON.parse(out) as {
      shapes: {
        id: string;
        type: string;
        frame: { x: number };
        data: { text: string };
      }[];
    };
    expect(parsed.shapes).toHaveLength(1);
    expect(parsed.shapes[0]?.id).toBe("s1");
    expect(parsed.shapes[0]?.type).toBe("note");
    expect(parsed.shapes[0]?.frame.x).toBe(10);
    expect(parsed.shapes[0]?.data.text).toBe("hi");
  });

  it("matches the in-process fallback byte-for-byte", async () => {
    // The worker and the in-process fallback share serializationCore, so their
    // output must be identical — this is what makes the fallback safe.
    const html = "<h1>Fallback</h1>\n<p>body</p>";
    const doc = await deserializeDocContent("space_b", "doc_b", null, html);
    const viaPool = await serializeDocContent("space_b", "doc_b", null, doc);
    const inProcess = contentFromDoc("space_b", "doc_b", null, doc);
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
    const out = await serializeDocContent("space_b", "doc_live", null, doc);
    expect(out).toContain("live text");
  });
});
