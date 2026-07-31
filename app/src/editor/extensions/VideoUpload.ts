import { type Editor, mergeAttributes, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { isVideoFile } from "#files/fileTypes.ts";
import { createResizableAttributes, ResizableNodeView } from "./resizable.ts";

export interface VideoUploadOptions {
  spaceId: string;
  documentId?: string;
}

const PLACEHOLDER_TEXT = "⏳ Uploading video...";

async function uploadVideo(
  file: File,
  spaceId: string,
  documentId?: string,
): Promise<string> {
  // Loaded on demand: uploading only ever happens in the browser, and this
  // extension is part of `contentExtensions`, which the server builds to
  // (de)serialize documents. A static import would pull the framework runtime
  // into the server (and every serialization worker) just to build a schema.
  const { useUploads } = await import("#composeables/useUploads.ts");
  // The editor owns the inline placeholder; the manager owns all toasts,
  // including the error one — a failed upload must never leave text behind
  // in the document, since that would sync to every collaborator.
  const result = await useUploads().uploadFile(file, {
    spaceId,
    documentId,
  });
  return result.url;
}

export function videoFilesFromDataTransfer(
  data: DataTransfer | null | undefined,
): File[] {
  return Array.from(data?.files || []).filter((file) => isVideoFile(file));
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

function replacePlaceholderWithVideo(editor: Editor, url: string): void {
  const range = findPlaceholder(editor);
  if (range) {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContentAt(range.from, { type: "video", attrs: { src: url } })
      .run();
  } else {
    editor
      .chain()
      .focus()
      .insertContent({ type: "video", attrs: { src: url } })
      .run();
  }
}

// The failure is reported by the upload manager's error toast; here we only
// clean up, so a failed upload leaves the document exactly as it was.
function removePlaceholder(editor: Editor): void {
  const range = findPlaceholder(editor);
  if (range) {
    editor.chain().focus().deleteRange(range).run();
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

  uploadVideo(file, spaceId, documentId)
    .then((url) => replacePlaceholderWithVideo(editor, url))
    .catch(() => removePlaceholder(editor));
}

export function insertVideoFilesAt(
  editor: Editor,
  view: EditorView,
  files: File[],
  insertPos: number,
  spaceId: string,
  documentId?: string,
): boolean {
  const videos = files.filter((file) => isVideoFile(file));
  if (!spaceId || videos.length === 0) return false;

  videos.forEach((file, index) => {
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

class ResizableVideoView extends ResizableNodeView {
  video: HTMLVideoElement;

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    super(node, view, getPos);

    this.dom.classList.add("video-wrapper");

    this.video = document.createElement("video");
    this.video.src = node.attrs.src;
    this.video.controls = true;
    this.video.style.display = "block";
    this.video.style.maxWidth = "100%";
    this.video.draggable = false;

    this.setupResizableContent(this.video, "width");
  }

  updateContent(): void {
    this.video.src = this.node.attrs.src;
  }
}

export const VideoUpload = Node.create<VideoUploadOptions>({
  name: "video",

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
      src: { default: null },
      ...createResizableAttributes(),
    };
  },

  parseHTML() {
    return [{ tag: "video[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["video", mergeAttributes({ controls: "" }, HTMLAttributes)];
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
      return new ResizableVideoView(node, view, getPos);
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const spaceId = this.options.spaceId;
    const documentId = this.options.documentId;

    return [
      new Plugin({
        key: new PluginKey("videoUploadPlugin"),
        props: {
          handleDrop(view, event) {
            if (!spaceId) return false;

            const videos = videoFilesFromDataTransfer(event.dataTransfer);
            if (videos.length === 0) return false;

            event.preventDefault();

            const coordinates = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            const insertPos = coordinates?.pos ?? view.state.selection.from;

            return insertVideoFilesAt(
              editor,
              view,
              videos,
              insertPos,
              spaceId,
              documentId,
            );
          },

          handlePaste(view, event) {
            if (!spaceId) return false;

            const items = Array.from(event.clipboardData?.items || []);
            const videoItems = items.filter((item) => {
              const file = item.getAsFile();
              return file && isVideoFile(file);
            });

            if (videoItems.length === 0) return false;

            event.preventDefault();

            for (const item of videoItems) {
              const file = item.getAsFile();
              if (!file) continue;
              insertPlaceholderAndUpload(
                editor,
                view,
                file,
                view.state.selection.from,
                spaceId,
                documentId,
              );
            }

            return true;
          },
        },
      }),
    ];
  },
});

export async function handleVideoUpload(
  editor: Editor,
  spaceId: string,
  documentId?: string,
): Promise<void> {
  if (!spaceId) {
    alert("Video upload is not available in this editor.");
    return;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "video/*";
  input.multiple = false;

  input.onchange = async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    if (!isVideoFile(file)) {
      alert("Please select a video file");
      return;
    }

    editor.chain().focus().insertContent(PLACEHOLDER_TEXT).run();

    try {
      const url = await uploadVideo(file, spaceId, documentId);
      replacePlaceholderWithVideo(editor, url);
    } catch {
      removePlaceholder(editor);
    }
  };

  input.click();
}
