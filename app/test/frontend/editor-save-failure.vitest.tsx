import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToast } from "#composeables/useToast.ts";

/**
 * A publish that the server refuses must never look like one that worked. Each
 * of the three save modes reaches the network through a different call that
 * swallows its own rejection, so each one needs its own report — the editor
 * stays open, and `saveStatus`/`saveError` are what the toolbar renders.
 */

vi.mock("#composeables/useSpace.ts", () => ({
  useSpace: () => ({
    currentSpaceId: () => "space_1",
    currentSpace: () => ({ id: "space_1", userRole: "editor" }),
  }),
}));

vi.mock("@solidjs/router", () => ({ useNavigate: () => () => {} }));
vi.mock("#composeables/useSync.ts", () => ({ useSync: () => {} }));
vi.mock("#composeables/useProperties.ts", () => ({
  useProperties: () => ({ updateProperty: () => propertyPatch() }),
}));

const documentPut = vi.fn();
const revisionPost = vi.fn();
const propertyPatch = vi.fn();

vi.mock("#api/client.ts", () => ({
  api: {
    document: {
      get: async () => null,
      getCached: async () => undefined,
      subscribeCached: () => () => {},
      put: (...args: unknown[]) => documentPut(...args),
      post: (...args: unknown[]) => revisionPost(...args),
    },
  },
}));

const { toasts, drop } = useToast();

function clearToasts() {
  for (const toast of toasts()) drop(toast.id);
}

function messages(type?: "error" | "success") {
  return toasts()
    .filter((toast) => !type || toast.type === type)
    .map((toast) => toast.message);
}

beforeEach(() => {
  clearToasts();
  // The doubles are module-level, so history leaks between tests otherwise.
  documentPut.mockReset().mockResolvedValue({ document: {} });
  revisionPost.mockReset().mockResolvedValue({ rev: 2 });
  propertyPatch.mockReset().mockResolvedValue(undefined);
});

afterEach(clearToasts);

/** Drive one save through a real `useEditor`, then report what it left behind. */
async function save(mode: "revision" | "suggestion" | "template") {
  const { useEditor, setEditing } = await import("#composeables/useEditor.ts");
  let result = { status: "", error: undefined as string | undefined, editing: false };

  await createRoot(async (dispose) => {
    const editor = useEditor({
      spaceId: "space_1",
      documentId: () => "doc_1",
      documentType: () => "document",
      readonly: () => false,
      getEditorHtml: () => "<p>edited</p>",
      collaboration: { joinUntilReady: async () => {}, leave: () => {} },
    });

    setEditing(true);
    await editor.finishEditing(mode);
    result = {
      status: editor.saveStatus(),
      error: editor.saveError()?.message,
      editing: editor.editing(),
    };
    setEditing(false);
    dispose();
  });

  return result;
}

describe("save failures in the editor", () => {
  it("reports a refused publish and keeps the session open", async () => {
    documentPut.mockRejectedValue(new Error("API request failed: 403 Forbidden"));

    const result = await save("revision");

    expect(result.status).toBe("error");
    expect(result.error).toContain("403");
    // Leaving edit mode is what made a refused publish read as a success.
    expect(result.editing).toBe(true);
    expect(messages("error")).toEqual(["API request failed: 403 Forbidden"]);
    expect(messages("success")).toEqual([]);
  });

  it("reports a refused suggestion", async () => {
    revisionPost.mockRejectedValue(new Error("Forbidden"));

    const result = await save("suggestion");

    expect(result.status).toBe("error");
    expect(result.error).toBe("Forbidden");
    expect(messages("error")).toEqual(["Forbidden"]);
  });

  it("reports a template marker that could not be written, and does not publish", async () => {
    propertyPatch.mockRejectedValue(new Error("Forbidden"));

    const result = await save("template");

    expect(result.status).toBe("error");
    expect(result.error).toBe("Forbidden");
    expect(messages("error")).toEqual(["Forbidden"]);
    expect(documentPut).not.toHaveBeenCalled();
  });

  it("says so once, and only once, when the publish succeeds", async () => {
    const result = await save("revision");

    expect(result.status).toBe("saved");
    expect(result.editing).toBe(false);
    expect(messages()).toEqual(["Document published"]);
  });
});
