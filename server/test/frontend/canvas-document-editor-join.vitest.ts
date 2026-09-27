import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import "#canvas/extensions/documentEditor.ts";
// The embed imports this lazily inside its join. Warming it here keeps the
// waits below short enough that the negative assertion is not a long sleep.
import "#editor/document.ts";
import type { CanvasDocumentCollaboration } from "#canvas/document/collaboration.ts";
import { CollaborationJoinAbandoned } from "#editor/collaboration.ts";

/** A session that only ever answers the one join the embed makes. */
function collaborationRejectingWith(error: Error): CanvasDocumentCollaboration {
  return {
    ydoc: () => new Y.Doc(),
    joinUntilReady: () => Promise.reject(error),
    setPresenceState: () => {},
    setupPresence: () => {},
    updatePresence: () => {},
    presenceProfiles: () => [],
    appearance: () => undefined,
    subscribe: () => () => {},
    dispose: () => {},
  };
}

async function mountEmbed(error: Error): Promise<HTMLElement> {
  const element = document.createElement("canvas-document-editor") as HTMLElement & {
    spaceId: string;
    documentId: string;
    collaboration: CanvasDocumentCollaboration | null;
  };
  element.spaceId = "space-1";
  element.documentId = "doc-1";
  document.body.append(element);
  element.collaboration = collaborationRejectingWith(error);

  // The embed starts on a microtask, awaits the document view, then renders on
  // another. Settle every hop before reading the DOM.
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("a canvas document embed whose join fails", () => {
  // The control: without it the assertion below passes on an embed that never
  // reached the join at all.
  it("paints a real failure", async () => {
    const element = await mountEmbed(new Error("The server refused the document"));
    expect(element.textContent).toContain("The server refused the document");
  });

  it("stays connecting when the session simply left the room", async () => {
    const abandoned = new CollaborationJoinAbandoned();
    const element = await mountEmbed(abandoned);
    expect(element.textContent).not.toContain(abandoned.message);
    expect(element.textContent).toContain("Connecting");
  });
});
