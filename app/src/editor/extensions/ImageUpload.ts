import Image from "@tiptap/extension-image";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { type Editor, mergeAttributes } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { ResizableNodeView, createResizableAttributes } from "./resizable.ts";

export interface ImageUploadOptions {
  spaceId: string;
  documentId?: string;
  uploadUrl?: string;
}

async function uploadImage(
  file: File,
  spaceId: string,
  documentId?: string,
): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);
  if (documentId) {
    formData.append("documentId", documentId);
  }

  const response = await fetch(`/api/v1/spaces/${spaceId}/uploads`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to upload image");
  }

  const data = await response.json();
  return data.url;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
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
            const items = Array.from(event.clipboardData?.items || []);
            const imageItems = items.filter((item) => item.type.indexOf("image") === 0);

            if (imageItems.length === 0) {
              return false;
            }

            event.preventDefault();

            for (const item of imageItems) {
              const file = item.getAsFile();
              if (file) {
                const insertPos = view.state.selection.from;
                const placeholderText = "⏳ Uploading image...";

                const tr = view.state.tr;
                tr.insertText(placeholderText, insertPos);
                view.dispatch(tr);

                uploadImage(file, spaceId, documentId)
                  .then((url) => {
                    const state = editor.state;
                    let foundPos = -1;
                    let foundLength = 0;

                    state.doc.descendants((node, pos) => {
                      if (node.isText && node.text?.includes(placeholderText)) {
                        const textOffset = node.text.indexOf(placeholderText);
                        foundPos = pos + textOffset;
                        foundLength = placeholderText.length;
                        return false;
                      }
                    });

                    if (foundPos >= 0) {
                      editor
                        .chain()
                        .focus()
                        .deleteRange({ from: foundPos, to: foundPos + foundLength })
                        .insertContentAt(foundPos, {
                          type: "image",
                          attrs: { src: url },
                        })
                        .run();
                    } else {
                      editor.chain().focus().setImage({ src: url }).run();
                    }
                  })
                  .catch((error) => {
                    const state = editor.state;
                    let foundPos = -1;
                    let foundLength = 0;

                    state.doc.descendants((node, pos) => {
                      if (node.isText && node.text?.includes(placeholderText)) {
                        const textOffset = node.text.indexOf(placeholderText);
                        foundPos = pos + textOffset;
                        foundLength = placeholderText.length;
                        return false;
                      }
                    });

                    if (foundPos >= 0) {
                      editor
                        .chain()
                        .focus()
                        .deleteRange({ from: foundPos, to: foundPos + foundLength })
                        .insertContent(`❌ Failed to upload image: ${error.message}`)
                        .run();
                    }
                  });
              }
            }

            return true;
          },

          handleDrop(view, event) {
            const hasFiles = event.dataTransfer?.files?.length;

            if (!hasFiles) {
              return false;
            }

            const images = Array.from(event.dataTransfer.files).filter((file) =>
              isImageFile(file),
            );

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

            for (const file of images) {
              const insertPos = coordinates.pos;
              const placeholderText = "⏳ Uploading image...";

              const tr = view.state.tr;
              tr.insertText(placeholderText, insertPos);
              view.dispatch(tr);

              uploadImage(file, spaceId, documentId)
                .then((url) => {
                  const state = editor.state;
                  let foundPos = -1;
                  let foundLength = 0;

                  state.doc.descendants((node, pos) => {
                    if (node.isText && node.text?.includes(placeholderText)) {
                      const textOffset = node.text.indexOf(placeholderText);
                      foundPos = pos + textOffset;
                      foundLength = placeholderText.length;
                      return false;
                    }
                  });

                  if (foundPos >= 0) {
                    editor
                      .chain()
                      .focus()
                      .deleteRange({ from: foundPos, to: foundPos + foundLength })
                      .insertContentAt(foundPos, {
                        type: "image",
                        attrs: { src: url },
                      })
                      .run();
                  } else {
                    editor.chain().focus().setImage({ src: url }).run();
                  }
                })
                .catch((error) => {
                  const state = editor.state;
                  let foundPos = -1;
                  let foundLength = 0;

                  state.doc.descendants((node, pos) => {
                    if (node.isText && node.text?.includes(placeholderText)) {
                      const textOffset = node.text.indexOf(placeholderText);
                      foundPos = pos + textOffset;
                      foundLength = placeholderText.length;
                      return false;
                    }
                  });

                  if (foundPos >= 0) {
                    editor
                      .chain()
                      .focus()
                      .deleteRange({ from: foundPos, to: foundPos + foundLength })
                      .insertContent(`❌ Failed to upload image: ${error.message}`)
                      .run();
                  }
                });
            }

            return true;
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

    const placeholderText = "⏳ Uploading image...";
    editor.chain().focus().insertContent(placeholderText).run();

    try {
      const url = await uploadImage(file, spaceId, documentId);

      const state = editor.state;
      let foundPos = -1;
      let foundLength = 0;

      state.doc.descendants((node, pos) => {
        if (node.isText && node.text?.includes(placeholderText)) {
          const textOffset = node.text.indexOf(placeholderText);
          foundPos = pos + textOffset;
          foundLength = placeholderText.length;
          return false;
        }
      });

      if (foundPos >= 0) {
        editor
          .chain()
          .focus()
          .deleteRange({ from: foundPos, to: foundPos + foundLength })
          .insertContentAt(foundPos, { type: "image", attrs: { src: url } })
          .run();
      } else {
        editor.chain().focus().setImage({ src: url }).run();
      }
    } catch (error) {
      const state = editor.state;
      let foundPos = -1;
      let foundLength = 0;

      state.doc.descendants((node, pos) => {
        if (node.isText && node.text?.includes(placeholderText)) {
          const textOffset = node.text.indexOf(placeholderText);
          foundPos = pos + textOffset;
          foundLength = placeholderText.length;
          return false;
        }
      });

      if (foundPos >= 0) {
        editor
          .chain()
          .focus()
          .deleteRange({ from: foundPos, to: foundPos + foundLength })
          .insertContent(
            `❌ Failed to upload image: ${error instanceof Error ? error.message : "Unknown error"}`,
          )
          .run();
      }
    }
  };

  input.click();
}
