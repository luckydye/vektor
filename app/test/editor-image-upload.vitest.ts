import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useToast } from "#composeables/useToast.ts";
import { Document, Paragraph, Text } from "#editor/extensions/baseExtensions.ts";
import { ImageUpload, insertImageFilesAt } from "#editor/extensions/ImageUpload.ts";

/**
 * The upload half of the image node: dropping or pasting a file has to reach
 * the upload manager and land an image node. The manager is a Solid composable
 * called from a ProseMirror plugin, where no owner is active — so anything it
 * reads from context breaks paste and drop silently.
 */

const uploadPost = vi.fn(async () => ({ url: "/api/v1/spaces/s/uploads/a.png" }));

vi.mock("#api/client.ts", () => ({
  api: { uploads: { post: (...args: unknown[]) => uploadPost(...args) } },
  isUploadAborted: () => false,
}));

let editor: Editor | null = null;

function createEditor() {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [Document, Paragraph, Text, ImageUpload],
  });
  return editor;
}

function imageSources(instance: Editor) {
  const sources: unknown[] = [];
  instance.state.doc.descendants((node) => {
    if (node.type.name === "image") sources.push(node.attrs.src);
  });
  return sources;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("image upload", () => {
  it("uploads a dropped file and inserts the returned image", async () => {
    const instance = createEditor();
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });

    expect(
      insertImageFilesAt(instance, instance.view, [file], 1, "space-1", "doc-1"),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(imageSources(instance)).toEqual(["/api/v1/spaces/s/uploads/a.png"]),
    );
    expect(instance.getText()).not.toContain("Uploading image");
  });

  it("reports a failed upload instead of dropping it silently", async () => {
    const instance = createEditor();
    const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    uploadPost.mockRejectedValueOnce(new Error("boom"));

    insertImageFilesAt(instance, instance.view, [file], 1, "space-1");

    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    expect(imageSources(instance)).toEqual([]);
    expect(instance.getText()).not.toContain("Uploading image");
    expect(
      useToast()
        .toasts()
        .some((toast) => toast.type === "error"),
    ).toBe(true);
  });
});
