import { type Editor, mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { useUploads } from "#composeables/useUploads.ts";
import { isImageFile } from "#utils/uploadFiles.ts";
import { createResizableAttributes, ResizableNodeView } from "./resizable.ts";

export interface ImageUploadOptions {
  spaceId: string;
  documentId?: string;
  uploadUrl?: string;
}

const PLACEHOLDER_TEXT = "⏳ Uploading image...";

async function uploadImage(
  file: File,
  spaceId: string,
  documentId?: string,
): Promise<string> {
  // The editor shows its own inline placeholder/error, so the manager only
  // drives the progress + success toast (errorToast disabled).
  const result = await useUploads().uploadFile(file, {
    spaceId,
    documentId,
    errorToast: false,
  });
  return result.url;
}

export function imageFilesFromDataTransfer(
  data: DataTransfer | null | undefined,
): File[] {
  return Array.from(data?.files || []).filter((file) => isImageFile(file));
}

function findPlaceholder(editor: Editor): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(PLACEHOLDER_TEXT)) {
      const textOffset = node.text.indexOf(PLACEHOLDER_TEXT);
      const from = pos + textOffset;
      found = { from, to: from + PLACEHOLDER_TEXT.length };
      return false;
    }
  });

  return found;
}

function replacePlaceholderWithImage(editor: Editor, url: string): void {
  const range = findPlaceholder(editor);
  if (range) {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContentAt(range.from, { type: "image", attrs: { src: url } })
      .run();
  } else {
    editor.chain().focus().setImage({ src: url }).run();
  }
}

function replacePlaceholderWithError(editor: Editor, error: unknown): void {
  const range = findPlaceholder(editor);
  if (range) {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent(
        `❌ Failed to upload image: ${error instanceof Error ? error.message : "Unknown error"}`,
      )
      .run();
  }
}

function insertPlaceholderAndUpload(
  editor: Editor,
  view: EditorView,
  file: File,
  insertPos: number,
  spaceId: string,
  documentId?: string,
): void {
  const tr = view.state.tr;
  tr.insertText(PLACEHOLDER_TEXT, insertPos);
  view.dispatch(tr);

  uploadImage(file, spaceId, documentId)
    .then((url) => replacePlaceholderWithImage(editor, url))
    .catch((error) => replacePlaceholderWithError(editor, error));
}

export function insertImageFilesAt(
  editor: Editor,
  view: EditorView,
  files: File[],
  insertPos: number,
  spaceId: string,
  documentId?: string,
): boolean {
  const images = files.filter((file) => isImageFile(file));
  if (!spaceId || images.length === 0) return false;

  images.forEach((file, index) => {
    insertPlaceholderAndUpload(
      editor,
      view,
      file,
      insertPos + index * PLACEHOLDER_TEXT.length,
      spaceId,
      documentId,
    );
  });

  return true;
}

class ResizableImageView extends ResizableNodeView {
  img: HTMLImageElement;

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    super(node, view, getPos);

    this.dom.classList.add("image-wrapper");

    this.img = document.createElement("img");
    this.img.src = node.attrs.src;
    this.img.alt = node.attrs.alt || "";
    this.img.title = node.attrs.title || "";
    this.img.style.height = "auto";
    this.img.style.display = "block";
    this.img.draggable = false;

    this.setupResizableContent(this.img, "width");
  }

  updateContent(): void {
    this.img.src = this.node.attrs.src;
    this.img.alt = this.node.attrs.alt || "";
    this.img.title = this.node.attrs.title || "";
  }
}

export const ImageUpload = Image.extend<ImageUploadOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      spaceId: "",
      documentId: undefined,
      uploadUrl: undefined,
      inline: false,
      allowBase64: false,
    };
  },

  addNodeView() {
    return ({
      node,
      view,
      getPos,
    }: {
      node: ProseMirrorNode;
      view: EditorView;
      getPos: () => number | undefined;
    }) => {
      return new ResizableImageView(node, view, getPos);
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      ...createResizableAttributes(),
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const spaceId = this.options.spaceId;
    const documentId = this.options.documentId;

    return [
      ...(this.parent?.() || []),
      new Plugin({
        key: new PluginKey("imageUploadPlugin"),
        props: {
          handlePaste(view, event) {
            if (!spaceId) {
              return false;
            }

            const items = Array.from(event.clipboardData?.items || []);
            const imageItems = items.filter((item) => item.type.indexOf("image") === 0);

            if (imageItems.length === 0) {
              return false;
            }

            event.preventDefault();

            for (const item of imageItems) {
              const file = item.getAsFile();
              if (file) {
                insertPlaceholderAndUpload(
                  editor,
                  view,
                  file,
                  view.state.selection.from,
                  spaceId,
                  documentId,
                );
              }
            }

            return true;
          },

          handleDrop(view, event) {
            if (!spaceId) {
              return false;
            }

            const hasFiles = event.dataTransfer?.files?.length;

            if (!hasFiles) {
              return false;
            }

            const images = imageFilesFromDataTransfer(event.dataTransfer);

            if (images.length === 0) {
              return false;
            }

            event.preventDefault();

            const coordinates = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });

            if (!coordinates) {
              return false;
            }

            return insertImageFilesAt(
              editor,
              view,
              images,
              coordinates.pos,
              spaceId,
              documentId,
            );
          },
        },
      }),
    ];
  },
});

export async function handleImageUpload(
  editor: Editor,
  spaceId: string,
  documentId?: string,
): Promise<void> {
  if (!spaceId) {
    alert("Image upload is not available in this editor.");
    return;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = false;

  input.onchange = async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    if (!isImageFile(file)) {
      alert("Please select an image file");
      return;
    }

    editor.chain().focus().insertContent(PLACEHOLDER_TEXT).run();

    try {
      const url = await uploadImage(file, spaceId, documentId);
      replacePlaceholderWithImage(editor, url);
    } catch (error) {
      replacePlaceholderWithError(editor, error);
    }
  };

  input.click();
}
