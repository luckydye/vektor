import type { AnyExtension, Extensions } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import BulletList from "@tiptap/extension-bullet-list";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Heading from "@tiptap/extension-heading";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import ListItem from "@tiptap/extension-list-item";
import OrderedList from "@tiptap/extension-ordered-list";
import Paragraph from "@tiptap/extension-paragraph";
import Strike from "@tiptap/extension-strike";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import Text from "@tiptap/extension-text";
import TextAlign from "@tiptap/extension-text-align";
import { BackgroundColor, Color, TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { ColumnItem, ColumnLayout } from "./extensions/ColumnLayout.ts";
import { DatePicker } from "./extensions/DatePicker.ts";
import { ExpressionCell } from "./extensions/ExpressionCell.ts";
import { FigmaEmbed } from "./extensions/FigmaEmbed.ts";
import { FileAttachment } from "./extensions/FileAttachment.ts";
import { HtmlBlock } from "./extensions/HtmlBlock.ts";
import { ImageUpload } from "./extensions/ImageUpload.ts";
import { MarkdownPaste } from "./extensions/MarkdownPaste.ts";
import { Mentions } from "./extensions/Mentions.ts";
import { TicketLink } from "./extensions/TicketLink.ts";

export type EditorContext = {
  spaceId?: string;
  documentId?: string;
};

const colwidthAttribute = {
  default: [200],
  parseHTML: (element: HTMLElement) => {
    const colwidth = element.getAttribute("colwidth");
    return colwidth ? colwidth.split(",").map((w) => parseInt(w, 10)) : [200];
  },
  renderHTML: (attributes: { colwidth?: number[] }) => {
    if (!attributes.colwidth) {
      return { style: "width: 200px" };
    }
    return {
      colwidth: attributes.colwidth.join(","),
      style: `width: ${attributes.colwidth[0]}px`,
    };
  },
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
    withoutDefaultKeyboardShortcuts(ListItem),
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
      Table.configure({
        resizable: true,
      }),
    ),
    withoutDefaultKeyboardShortcuts(TableRow),
    withoutDefaultKeyboardShortcuts(
      TableHeader.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            colwidth: colwidthAttribute,
          };
        },
      }),
    ),
    withoutDefaultKeyboardShortcuts(
      TableCell.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            colwidth: colwidthAttribute,
            backgroundColor: {
              default: null,
              parseHTML: (element) => element.style.backgroundColor || null,
              renderHTML: (attributes) => {
                if (!attributes.backgroundColor) {
                  return {};
                }
                return {
                  style: `background-color: ${attributes.backgroundColor}`,
                };
              },
            },
          };
        },
      }),
    ),
    withoutDefaultKeyboardShortcuts(
      TaskItem.configure({
        nested: true,
      }),
    ),
    withoutDefaultKeyboardShortcuts(TaskList),
    withoutDefaultKeyboardShortcuts(Code),
    withoutDefaultKeyboardShortcuts(CodeBlock),

    // custom extensions
    MarkdownPaste,
    TicketLink,
    ExpressionCell,
    ColumnLayout,
    ColumnItem,
    HtmlBlock,
    DatePicker,
    FigmaEmbed,
    Mentions,
  ];
}
