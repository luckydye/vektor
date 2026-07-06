import { type Editor, mergeAttributes, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import { useUploads } from "#composeables/useUploads.ts";

export interface FileAttachmentOptions {
  spaceId: string;
  documentId?: string;
}

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "svg"];
const DOCUMENT_EXTENSIONS = [
  "docx",
  "doc",
  "pdf",
  "pptx",
  "ppt",
  "md",
  "txt",
  "xlsx",
  "xls",
  "csv",
  "zip",
  "obj",
];

function getFileExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() || "";
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const ext = getFileExtension(file.name);
  return IMAGE_EXTENSIONS.includes(ext);
}

function isSupportedDocumentFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  if (DOCUMENT_EXTENSIONS.includes(ext)) return true;

  const supportedMimeTypes = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.ms-excel",
    "application/msword",
    "application/pdf",
    "application/zip",
    "model/obj",
    "text/markdown",
    "text/plain",
    "text/csv",
  ];

  return supportedMimeTypes.includes(file.type);
}

async function uploadFile(
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

// Simple NodeView wrapper that uses the file-attachment custom element
class FileAttachmentView implements NodeView {
  dom: HTMLElement;
  node: ProseMirrorNode;

  constructor(node: ProseMirrorNode) {
    this.node = node;

    const { src, filename } = node.attrs;

    this.dom = document.createElement("file-attachment");
    this.dom.setAttribute("src", src || "");
    this.dom.setAttribute("filename", filename || "file");
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;

    const { src, filename } = node.attrs;
    this.dom.setAttribute("src", src || "");
    this.dom.setAttribute("filename", filename || "file");

    return true;
  }

  selectNode(): void {
    (this.dom as HTMLElement).style.outline = "2px solid #3b82f6";
  }

  deselectNode(): void {
    (this.dom as HTMLElement).style.outline = "none";
  }

  stopEvent(): boolean {
    return false;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {}
}

export const FileAttachment = Node.create<FileAttachmentOptions>({
  name: "fileAttachment",

  group: "block",

  atom: true,

  addOptions() {
    return {
      spaceId: "",
      documentId: undefined,
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
      },
      filename: {
        default: "file",
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "file-attachment",
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["file-attachment", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ({ node }) => {
      return new FileAttachmentView(node);
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const spaceId = this.options.spaceId;
    const documentId = this.options.documentId;

    function insertPlaceholderAndUpload(
      view: EditorView,
      file: File,
      insertPos: number,
    ): void {
      const placeholderText = `⏳ Uploading ${file.name}...`;

      const tr = view.state.tr;
      tr.insertText(placeholderText, insertPos);
      view.dispatch(tr);

      uploadFile(file, spaceId, documentId)
        .then((url) => {
          replacePlaceholderWithAttachment(editor, placeholderText, url, file.name);
        })
        .catch((error) => {
          replacePlaceholderWithError(editor, placeholderText, error);
        });
    }

    return [
      new Plugin({
        key: new PluginKey("fileAttachmentPlugin"),
        props: {
          handlePaste(view, event) {
            if (!spaceId) {
              return false;
            }

            const items = Array.from(event.clipboardData?.items || []);
            const fileItems = items.filter((item) => {
              const file = item.getAsFile();
              return file && isSupportedDocumentFile(file) && !isImageFile(file);
            });

            if (fileItems.length === 0) return false;

            event.preventDefault();

            for (const item of fileItems) {
              const file = item.getAsFile();
              if (!file) continue;

              insertPlaceholderAndUpload(view, file, view.state.selection.from);
            }

            return true;
          },

          handleDrop(view, event) {
            if (!spaceId) {
              return false;
            }

            const hasFiles = event.dataTransfer?.files?.length;
            if (!hasFiles) return false;

            const files = Array.from(event.dataTransfer.files).filter(
              (file) => isSupportedDocumentFile(file) && !isImageFile(file),
            );

            if (files.length === 0) return false;

            event.preventDefault();

            const coordinates = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });

            if (!coordinates) return false;

            for (const file of files) {
              insertPlaceholderAndUpload(view, file, coordinates.pos);
            }

            return true;
          },
        },
      }),
    ];
  },
});

function findPlaceholder(
  editor: Editor,
  placeholderText: string,
): { pos: number; length: number } | null {
  let foundPos = -1;
  let foundLength = 0;

  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(placeholderText)) {
      const textOffset = node.text.indexOf(placeholderText);
      foundPos = pos + textOffset;
      foundLength = placeholderText.length;
      return false;
    }
  });

  if (foundPos >= 0) {
    return { pos: foundPos, length: foundLength };
  }
  return null;
}

function replacePlaceholderWithAttachment(
  editor: Editor,
  placeholderText: string,
  url: string,
  filename: string,
): void {
  const placeholder = findPlaceholder(editor, placeholderText);

  if (placeholder) {
    editor
      .chain()
      .focus()
      .deleteRange({
        from: placeholder.pos,
        to: placeholder.pos + placeholder.length,
      })
      .insertContentAt(placeholder.pos, {
        type: "fileAttachment",
        attrs: { src: url, filename },
      })
      .run();
  } else {
    editor
      .chain()
      .focus()
      .insertContent({
        type: "fileAttachment",
        attrs: { src: url, filename },
      })
      .run();
  }
}

function replacePlaceholderWithError(
  editor: Editor,
  placeholderText: string,
  error: unknown,
): void {
  const placeholder = findPlaceholder(editor, placeholderText);

  if (placeholder) {
    const message = error instanceof Error ? error.message : "Unknown error";
    editor
      .chain()
      .focus()
      .deleteRange({
        from: placeholder.pos,
        to: placeholder.pos + placeholder.length,
      })
      .insertContent(`❌ Failed to upload: ${message}`)
      .run();
  }
}
