import { Editor, type EditorOptions, Extension, type Extensions } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  canvasClipboardFromDataTransfer,
  canvasClipboardToDocumentHtml,
} from "#utils/clipboard.ts";
import {
  BackgroundColor,
  Blockquote,
  Bold,
  BulletList,
  Code,
  CodeBlock,
  Color,
  Document,
  HardBreak,
  Heading,
  HorizontalRule,
  Italic,
  Link,
  ListItem,
  OrderedList,
  Paragraph,
  Strike,
  Subscript,
  Superscript,
  TaskItem,
  TaskList,
  Text,
  TextAlign,
  TextStyle,
  Underline,
} from "./extensions/baseExtensions.ts";
import { ColumnItem, ColumnLayout } from "./extensions/ColumnLayout.ts";
import { CommentAnchor } from "./extensions/CommentAnchor.ts";
import { DatePicker } from "./extensions/DatePicker.ts";
import { ExtensionView } from "./extensions/ExtensionView.ts";
import { FigmaEmbed } from "./extensions/FigmaEmbed.ts";
import { FileAttachment } from "./extensions/FileAttachment.ts";
import { HtmlBlock } from "./extensions/HtmlBlock.ts";
import { ImageUpload } from "./extensions/ImageUpload.ts";
import { MarkdownPaste } from "./extensions/MarkdownPaste.ts";
import { Mentions } from "./extensions/Mentions.ts";
import { TicketLink } from "./extensions/TicketLink.ts";
import { TableEditing } from "./extensions/table.ts";
import { VideoUpload } from "./extensions/VideoUpload.ts";

export type EditorContext = {
  spaceId?: string;
  documentId?: string;
};

export type BaseEditorOptions = Partial<EditorOptions> & Pick<EditorOptions, "element">;

const LIST_ITEM_CLIPBOARD_MIME = "application/x-vektor-list-item";
const LIST_ITEM_CLIPBOARD_ATTRIBUTE = "data-vektor-list-item";

function selectNearestParentNode(editor: Editor) {
  const { state, view } = editor;
  const { selection } = state;
  const { $from, $to } = selection;
  const startDepth =
    selection instanceof NodeSelection ? $from.depth : $from.sharedDepth($to.pos);

  for (let depth = startDepth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (!NodeSelection.isSelectable(node)) continue;

    const tr = state.tr.setSelection(
      NodeSelection.create(state.doc, $from.before(depth)),
    );
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  const tr = state.tr.setSelection(
    TextSelection.create(state.doc, 0, state.doc.content.size),
  );
  view.dispatch(tr.scrollIntoView());
  return true;
}

function currentListItemRange(editor: Editor) {
  const { $from } = editor.state.selection;

  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "listItem" && node.type.name !== "taskItem") continue;

    const from = $from.before(depth);
    const to = from + node.nodeSize;
    const listDepth = depth - 1;
    const list = $from.node(listDepth);

    if (list.type.spec.group?.split(/\s+/).includes("list") && list.childCount === 1) {
      const deleteFrom = $from.before(listDepth);
      return {
        from,
        to,
        deleteFrom,
        deleteTo: deleteFrom + list.nodeSize,
      };
    }

    return { from, to, deleteFrom: from, deleteTo: to };
  }

  return null;
}

function currentParentNodeRange(editor: Editor) {
  const { $from } = editor.state.selection;

  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (!NodeSelection.isSelectable(node)) continue;

    const from = $from.before(depth);
    return { from, to: from + node.nodeSize };
  }

  return null;
}

function writeSliceToClipboard(
  view: EditorView,
  event: ClipboardEvent,
  slice: Slice,
  listItem: boolean,
) {
  if (!event.clipboardData) return false;

  const { dom, text } = view.serializeForClipboard(slice);
  if (listItem) {
    dom.firstElementChild?.setAttribute(LIST_ITEM_CLIPBOARD_ATTRIBUTE, "");
  }

  event.preventDefault();
  event.clipboardData.clearData();
  if (listItem) event.clipboardData.setData(LIST_ITEM_CLIPBOARD_MIME, "1");
  event.clipboardData.setData("text/html", dom.innerHTML);
  event.clipboardData.setData("text/plain", text);
  return true;
}

function moveListItemPasteToTextEnd(editor: Editor, event: ClipboardEvent) {
  const { state, view } = editor;
  const { selection } = state;
  const { $from } = selection;

  if (
    !(selection instanceof TextSelection) ||
    !selection.empty ||
    $from.parentOffset !== 0 ||
    $from.parent.type.name !== "paragraph"
  ) {
    return;
  }

  const html = event.clipboardData?.getData("text/html") ?? "";
  const isListItemCut =
    event.clipboardData?.getData(LIST_ITEM_CLIPBOARD_MIME) === "1" ||
    /<(?:ul|ol)\b[^>]*\bdata-vektor-list-item(?:\s|=|>)/i.test(html);
  if (!isListItemCut) return;

  for (let depth = $from.depth - 1; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "listItem" && node.type.name !== "taskItem") continue;
    if ($from.index(depth) !== 0) return;

    const textEnd = $from.end($from.depth);
    if (textEnd !== selection.from) {
      view.dispatch(
        state.tr.setSelection(TextSelection.create(state.doc, textEnd)).scrollIntoView(),
      );
    }
    return;
  }
}

function joinEmptyParagraphWithPreviousList(editor: Editor) {
  const { state, view } = editor;
  const { selection } = state;
  const { $from } = selection;

  if (
    !(selection instanceof TextSelection) ||
    !selection.empty ||
    $from.parentOffset !== 0 ||
    $from.parent.type.name !== "paragraph" ||
    $from.parent.content.size !== 0 ||
    $from.depth === 0
  ) {
    return false;
  }

  const containingDepth = $from.depth - 1;
  const paragraphIndex = $from.index(containingDepth);
  if (paragraphIndex === 0) return false;

  const previousNode = $from.node(containingDepth).child(paragraphIndex - 1);
  if (!previousNode.type.spec.group?.split(/\s+/).includes("list")) return false;

  const from = $from.before($from.depth);
  const tr = state.tr.delete(from, from + $from.parent.nodeSize);
  tr.setSelection(Selection.near(tr.doc.resolve(from), -1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

const BaseSelectionShortcuts = Extension.create({
  name: "baseSelectionShortcuts",

  addKeyboardShortcuts() {
    return {
      "Mod-a": () => selectNearestParentNode(this.editor),
      Backspace: () => joinEmptyParagraphWithPreviousList(this.editor),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: new PluginKey("blockClipboard"),
        props: {
          handleDOMEvents: {
            paste(_view, domEvent) {
              moveListItemPasteToTextEnd(editor, domEvent as ClipboardEvent);
              return false;
            },
            copy(view, domEvent) {
              if (!view.state.selection.empty) return false;

              const event = domEvent as ClipboardEvent;
              const listItemRange = currentListItemRange(editor);
              if (listItemRange) {
                const { from, to, deleteFrom } = listItemRange;
                if (!event.clipboardData) {
                  view.dispatch(
                    view.state.tr.setSelection(
                      NodeSelection.create(view.state.doc, deleteFrom),
                    ),
                  );
                  return false;
                }

                return writeSliceToClipboard(
                  view,
                  event,
                  view.state.doc.slice(from, to, true),
                  true,
                );
              }

              const nodeRange = currentParentNodeRange(editor);
              if (!nodeRange) return false;

              const nodeSelection = NodeSelection.create(
                view.state.doc,
                nodeRange.from,
              );
              if (!event.clipboardData) {
                view.dispatch(view.state.tr.setSelection(nodeSelection));
                return false;
              }

              return writeSliceToClipboard(
                view,
                event,
                nodeSelection.content(),
                false,
              );
            },
            cut(view, domEvent) {
              if (!view.state.selection.empty) return false;

              const listItemRange = currentListItemRange(editor);
              if (!listItemRange) {
                selectNearestParentNode(editor);
                return false;
              }

              const event = domEvent as ClipboardEvent;
              const { from, to, deleteFrom, deleteTo } = listItemRange;
              if (!event.clipboardData) {
                view.dispatch(
                  view.state.tr.setSelection(
                    NodeSelection.create(view.state.doc, deleteFrom),
                  ),
                );
                return false;
              }

              const slice = view.state.doc.slice(from, to, true);
              writeSliceToClipboard(view, event, slice, true);
              view.dispatch(
                view.state.tr
                  .delete(deleteFrom, deleteTo)
                  .scrollIntoView()
                  .setMeta("uiEvent", "cut"),
              );
              return true;
            },
          },
        },
      }),
    ];
  },
});

const CanvasClipboardPaste = Extension.create({
  name: "canvasClipboardPaste",

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: new PluginKey("canvasClipboardPaste"),
        props: {
          handlePaste(_view, event) {
            const payload = canvasClipboardFromDataTransfer(event.clipboardData);
            if (!payload) return false;

            const html = canvasClipboardToDocumentHtml(payload, {
              includeMetadata: false,
            });
            if (!html.trim()) return false;

            event.preventDefault();
            editor.chain().focus().insertContent(html).run();
            return true;
          },
        },
      }),
    ];
  },
});

function baseEditorExtensions(): Extensions {
  return [
    Document,
    Paragraph,
    Text,
    Link,
    Bold,
    Italic,
    HardBreak,
    BulletList,
    OrderedList,
    ListItem.extend({
      addKeyboardShortcuts() {
        return {
          Enter: () => this.editor.commands.splitListItem(this.name),
        };
      },
    }),
    BaseSelectionShortcuts,
  ];
}

export function createBaseEditor(options: BaseEditorOptions): Editor {
  const { extensions = [], ...editorOptions } = options;

  return new Editor({
    ...editorOptions,
    extensions: [...baseEditorExtensions(), ...extensions],
  });
}

export function documentExtensions(
  context: EditorContext = {},
  mentions: Extensions[number] = Mentions,
): Extensions {
  const { spaceId = "", documentId } = context;

  return [
    Strike,
    Underline,
    Superscript,
    Subscript,
    TextStyle,
    TextAlign.configure({
      types: ["heading", "paragraph"],
    }),
    BackgroundColor,
    Color,
    Heading.configure({
      levels: [1, 2, 3, 4],
    }),
    ImageUpload.configure({
      spaceId: spaceId,
      documentId: documentId,
    }),
    FileAttachment.configure({
      spaceId: spaceId,
      documentId: documentId,
    }),
    VideoUpload.configure({
      spaceId: spaceId,
      documentId: documentId,
    }),
    CanvasClipboardPaste,
    TableEditing,
    TaskItem.configure({ nested: true }).extend({
      addKeyboardShortcuts() {
        return {
          Enter: () => this.editor.commands.splitListItem(this.name),
        };
      },
    }),
    TaskList,
    Code,
    CodeBlock,
    Blockquote,
    HorizontalRule,

    // custom extensions
    CommentAnchor,
    ExtensionView,
    MarkdownPaste,
    TicketLink,
    ColumnLayout,
    ColumnItem,
    HtmlBlock,
    DatePicker,
    FigmaEmbed,
    mentions,
  ];
}

export function contentExtensions(context: EditorContext = {}): Extensions {
  return [...baseEditorExtensions(), ...documentExtensions(context)];
}
