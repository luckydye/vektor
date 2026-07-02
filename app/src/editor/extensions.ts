import { Editor, type EditorOptions, Extension, type Extensions } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import {
  BackgroundColor,
  Bold,
  BulletList,
  Code,
  CodeBlock,
  Color,
  Document,
  HardBreak,
  Heading,
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

const BaseSelectionShortcuts = Extension.create({
  name: "baseSelectionShortcuts",

  addKeyboardShortcuts() {
    return {
      "Mod-a": () => selectNearestParentNode(this.editor),
    };
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

export function documentExtensions(context: EditorContext = {}): Extensions {
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
    Mentions,
  ];
}

export function contentExtensions(context: EditorContext = {}): Extensions {
  return [...baseEditorExtensions(), ...documentExtensions(context)];
}
