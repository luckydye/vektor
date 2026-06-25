import type { AnyExtension, Extensions } from "@tiptap/core";
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

function withoutDefaultKeyboardShortcuts<T extends AnyExtension>(extension: T): T {
  return extension.extend({
    addKeyboardShortcuts: () => ({}),
  }) as T;
}

export function contentExtensions(context: EditorContext = {}): Extensions {
  const { spaceId = "", documentId } = context;

  return [
    withoutDefaultKeyboardShortcuts(Document),
    withoutDefaultKeyboardShortcuts(Paragraph),
    withoutDefaultKeyboardShortcuts(Text),
    withoutDefaultKeyboardShortcuts(Link),
    withoutDefaultKeyboardShortcuts(Bold),
    withoutDefaultKeyboardShortcuts(Italic),
    withoutDefaultKeyboardShortcuts(Strike),
    withoutDefaultKeyboardShortcuts(Underline),
    withoutDefaultKeyboardShortcuts(Superscript),
    withoutDefaultKeyboardShortcuts(Subscript),
    withoutDefaultKeyboardShortcuts(TextStyle),
    withoutDefaultKeyboardShortcuts(
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
    ),
    withoutDefaultKeyboardShortcuts(HardBreak),
    withoutDefaultKeyboardShortcuts(BackgroundColor),
    withoutDefaultKeyboardShortcuts(Color),
    withoutDefaultKeyboardShortcuts(
      Heading.configure({
        levels: [1, 2, 3, 4],
      }),
    ),
    withoutDefaultKeyboardShortcuts(BulletList),
    withoutDefaultKeyboardShortcuts(OrderedList),
    ListItem.extend({
      addKeyboardShortcuts() {
        return {
          Enter: () => this.editor.commands.splitListItem(this.name),
        };
      },
    }),
    withoutDefaultKeyboardShortcuts(
      ImageUpload.configure({
        spaceId: spaceId,
        documentId: documentId,
      }),
    ),
    withoutDefaultKeyboardShortcuts(
      FileAttachment.configure({
        spaceId: spaceId,
        documentId: documentId,
      }),
    ),
    withoutDefaultKeyboardShortcuts(
      VideoUpload.configure({
        spaceId: spaceId,
        documentId: documentId,
      }),
    ),
    TableEditing,
    TaskItem.configure({ nested: true }).extend({
      addKeyboardShortcuts() {
        return {
          Enter: () => this.editor.commands.splitListItem(this.name),
        };
      },
    }),
    withoutDefaultKeyboardShortcuts(TaskList),
    withoutDefaultKeyboardShortcuts(Code),
    withoutDefaultKeyboardShortcuts(CodeBlock),

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
