import type { Editor } from "@tiptap/core";
import { Actions } from "./actions.ts";
import { t } from "./lang.ts";

/**
 * Register all formatting actions
 */
export function registerFormattingActions(getEditor: () => Editor) {
  const isEditorAvailable = () => {
    const editor = getEditor();
    return editor && !editor.isDestroyed;
  };

  // Text formatting
  Actions.register("format:bold", {
    title: t("Bold"),
    description: t("Toggle bold formatting"),
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleBold().run();
    },
  });

  Actions.register("format:italic", {
    title: t("Italic"),
    description: t("Toggle italic formatting"),
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleItalic().run();
    },
  });

  Actions.register("format:underline", {
    title: t("Underline"),
    description: t("Toggle underline formatting"),
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleUnderline().run();
    },
  });

  Actions.register("format:strikethrough", {
    title: t("Strikethrough"),
    description: t("Toggle strikethrough formatting"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleStrike().run();
    },
  });

  Actions.register("format:code", {
    title: t("Inline Code"),
    description: t("Toggle inline code formatting"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleCode().run();
    },
  });

  Actions.register("format:subscript", {
    title: t("Subscript"),
    description: t("Toggle subscript formatting"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleSubscript().run();
    },
  });

  Actions.register("format:superscript", {
    title: t("Superscript"),
    description: t("Toggle superscript formatting"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleSuperscript().run();
    },
  });

  // Headings
  Actions.register("format:heading:paragraph", {
    title: t("Paragraph"),
    description: t("Convert to normal paragraph"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setParagraph().run();
    },
  });

  Actions.register("format:heading:1", {
    title: t("Heading 1"),
    description: t("Convert to heading level 1"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 1 }).run();
    },
  });

  Actions.register("format:heading:2", {
    title: t("Heading 2"),
    description: t("Convert to heading level 2"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 2 }).run();
    },
  });

  Actions.register("format:heading:3", {
    title: t("Heading 3"),
    description: t("Convert to heading level 3"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 3 }).run();
    },
  });

  Actions.register("format:heading:4", {
    title: t("Heading 4"),
    description: t("Convert to heading level 4"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 4 }).run();
    },
  });

  Actions.register("format:heading:5", {
    title: t("Heading 5"),
    description: t("Convert to heading level 5"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 5 }).run();
    },
  });

  Actions.register("format:heading:6", {
    title: t("Heading 6"),
    description: t("Convert to heading level 6"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 6 }).run();
    },
  });

  // Lists
  Actions.register("format:list:bullet", {
    title: t("Bullet List"),
    description: t("Toggle bullet list"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleBulletList().run();
    },
  });

  Actions.register("format:list:ordered", {
    title: t("Numbered List"),
    description: t("Toggle numbered list"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleOrderedList().run();
    },
  });

  Actions.register("format:list:task", {
    title: t("Task List"),
    description: t("Toggle task/checkbox list"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleTaskList().run();
    },
  });

  Actions.register("format:list:indent", {
    title: t("Indent List Item"),
    description: t("Indent the current list item"),
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      const editor = getEditor();
      // Check taskItem first since isActive is more reliable than can() for determining node type
      if (editor.isActive("taskItem") && editor.can().sinkListItem("taskItem")) {
        editor.chain().focus().sinkListItem("taskItem").run();
      } else if (editor.can().sinkListItem("listItem")) {
        editor.chain().focus().sinkListItem("listItem").run();
      }
    },
  });

  Actions.register("format:list:outdent", {
    title: t("Outdent List Item"),
    description: t("Outdent the current list item"),
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      const editor = getEditor();
      // Check taskItem first since isActive is more reliable than can() for determining node type
      if (editor.isActive("taskItem") && editor.can().liftListItem("taskItem")) {
        editor.chain().focus().liftListItem("taskItem").run();
      } else if (editor.can().liftListItem("listItem")) {
        editor.chain().focus().liftListItem("listItem").run();
      }
    },
  });

  // Text alignment
  Actions.register("format:align:left", {
    title: t("Align Left"),
    description: t("Align text to the left"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setTextAlign("left").run();
    },
  });

  Actions.register("format:align:center", {
    title: t("Align Center"),
    description: t("Center align text"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setTextAlign("center").run();
    },
  });

  Actions.register("format:align:right", {
    title: t("Align Right"),
    description: t("Align text to the right"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setTextAlign("right").run();
    },
  });

  Actions.register("format:align:justify", {
    title: t("Justify"),
    description: t("Justify text alignment"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setTextAlign("justify").run();
    },
  });

  // Block elements
  Actions.register("format:blockquote", {
    title: t("Blockquote"),
    description: t("Toggle blockquote"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleBlockquote().run();
    },
  });

  Actions.register("format:codeblock", {
    title: t("Code Block"),
    description: t("Toggle code block"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleCodeBlock().run();
    },
  });

  Actions.register("format:horizontalrule", {
    title: t("Horizontal Rule"),
    description: t("Insert horizontal divider line"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setHorizontalRule().run();
    },
  });

  Actions.register("format:hardbreak", {
    title: t("Hard Break"),
    description: t("Insert a hard line break"),
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setHardBreak().run();
    },
  });

  // Links
  Actions.register("format:link", {
    title: t("Insert Link"),
    description: t("Add or edit a hyperlink"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      const editor = getEditor();
      const previousUrl = editor.getAttributes("link").href;
      const url = window.prompt("Enter URL:", previousUrl);

      if (url === null) {
        return;
      }

      if (url === "") {
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
        return;
      }

      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    },
  });

  Actions.register("format:unlink", {
    title: t("Remove Link"),
    description: t("Remove hyperlink from selection"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().unsetLink().run();
    },
  });

  // History
  Actions.register("format:undo", {
    title: t("Undo"),
    description: t("Undo the last action"),
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().undo().run();
    },
  });

  Actions.register("format:redo", {
    title: t("Redo"),
    description: t("Redo the last undone action"),
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().redo().run();
    },
  });

  // Table operations
  Actions.register("format:table:insert", {
    title: t("Insert Table"),
    description: t("Insert a new table"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor()
        .chain()
        .focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run();
    },
  });

  Actions.register("format:table:delete", {
    title: t("Delete Table"),
    description: t("Delete the current table"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().deleteTable().run();
    },
  });

  Actions.register("format:table:addColumnBefore", {
    title: t("Add Column Before"),
    description: t("Add a column before the current one"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().addColumnBefore().run();
    },
  });

  Actions.register("format:table:addColumnAfter", {
    title: t("Add Column After"),
    description: t("Add a column after the current one"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().addColumnAfter().run();
    },
  });

  Actions.register("format:table:deleteColumn", {
    title: t("Delete Column"),
    description: t("Delete the current column"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().deleteColumn().run();
    },
  });

  Actions.register("format:table:addRowBefore", {
    title: t("Add Row Before"),
    description: t("Add a row before the current one"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().addRowBefore().run();
    },
  });

  Actions.register("format:table:addRowAfter", {
    title: t("Add Row After"),
    description: t("Add a row after the current one"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().addRowAfter().run();
    },
  });

  Actions.register("format:table:deleteRow", {
    title: t("Delete Row"),
    description: t("Delete the current row"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().deleteRow().run();
    },
  });

  Actions.register("format:table:mergeCells", {
    title: t("Merge Cells"),
    description: t("Merge selected cells"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().mergeCells().run();
    },
  });

  Actions.register("format:table:splitCell", {
    title: t("Split Cell"),
    description: t("Split the current cell"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().splitCell().run();
    },
  });

  Actions.register("format:table:toggleHeaderRow", {
    title: t("Toggle Header Row"),
    description: t("Toggle the header row of the table"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeaderRow().run();
    },
  });

  Actions.register("format:table:toggleHeaderColumn", {
    title: t("Toggle Header Column"),
    description: t("Toggle the header column of the table"),
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeaderColumn().run();
    },
  });

  // Column layout
  Actions.register("format:columns:2", {
    title: t("2 Columns"),
    description: t("Insert or set 2-column layout"),
    group: "layout",
    run: async () => {
      if (!isEditorAvailable()) return;
      const editor = getEditor();
      if (editor.isActive("columnLayout")) {
        // Update existing column layout
        setColumnCount(editor, 2);
      } else {
        editor.chain().focus().setColumnLayout({ columns: 2 }).run();
      }
    },
  });

  Actions.register("format:columns:3", {
    title: t("3 Columns"),
    description: t("Insert or set 3-column layout"),
    group: "layout",
    run: async () => {
      if (!isEditorAvailable()) return;
      const editor = getEditor();
      if (editor.isActive("columnLayout")) {
        setColumnCount(editor, 3);
      } else {
        editor.chain().focus().setColumnLayout({ columns: 3 }).run();
      }
    },
  });

  Actions.register("format:columns:4", {
    title: t("4 Columns"),
    description: t("Insert or set 4-column layout"),
    group: "layout",
    run: async () => {
      if (!isEditorAvailable()) return;
      const editor = getEditor();
      if (editor.isActive("columnLayout")) {
        setColumnCount(editor, 4);
      } else {
        editor.chain().focus().setColumnLayout({ columns: 4 }).run();
      }
    },
  });

  Actions.register("format:columns:delete", {
    title: t("Delete Column Layout"),
    description: t("Remove the column layout"),
    group: "layout",
    run: async () => {
      if (!isEditorAvailable()) return;
      const editor = getEditor();
      const { state } = editor;
      const { selection } = state;
      const { $from } = selection;

      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === "columnLayout") {
          const pos = $from.before(d);
          const { tr } = state;
          tr.delete(pos, pos + node.nodeSize);
          editor.view.dispatch(tr);
          return;
        }
      }
    },
  });

  // Clear formatting
  Actions.register("format:clear", {
    title: t("Clear Formatting"),
    description: t("Remove all formatting from selection"),
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().clearNodes().unsetAllMarks().run();
    },
  });

  // Text color (these require user input, so they just focus the relevant input)
  Actions.register("format:color:text", {
    title: t("Text Color"),
    description: t("Change text color"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      // This action triggers an event that the toolbar can listen to
      Actions.emit("format:color:text:open", {});
    },
  });

  Actions.register("format:color:background", {
    title: t("Background Color"),
    description: t("Change text background color"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      Actions.emit("format:color:background:open", {});
    },
  });

  Actions.register("format:color:clear", {
    title: t("Clear Background Color"),
    description: t("Remove background color from text"),
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().unsetBackgroundColor().run();
    },
  });
}

/**
 * Helper function to set column count on an existing column layout
 */
function setColumnCount(editor: Editor, newCount: number) {
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;

  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "columnLayout") {
      const pos = $from.before(d);
      const currentColumns = node.content.childCount;

      const { tr } = state;

      if (newCount > currentColumns) {
        for (let i = currentColumns; i < newCount; i++) {
          const columnNode = editor.schema.nodes.columnItem.create(
            null,
            editor.schema.nodes.paragraph.create(),
          );
          tr.insert(pos + node.nodeSize - 1, columnNode);
        }
      } else if (newCount < currentColumns) {
        let offset = 0;
        for (let i = 0; i < currentColumns; i++) {
          const child = node.child(i);
          if (i >= newCount) {
            tr.delete(pos + 1 + offset, pos + 1 + offset + child.nodeSize);
          } else {
            offset += child.nodeSize;
          }
        }
      }

      tr.setNodeMarkup(pos, null, { columns: newCount });
      editor.view.dispatch(tr);
      return;
    }
  }
}

/**
 * Unregister all formatting actions
 */
export function unregisterFormattingActions() {
  const actionIds = [
    "format:bold",
    "format:italic",
    "format:underline",
    "format:strikethrough",
    "format:code",
    "format:subscript",
    "format:superscript",
    "format:heading:paragraph",
    "format:heading:1",
    "format:heading:2",
    "format:heading:3",
    "format:heading:4",
    "format:heading:5",
    "format:heading:6",
    "format:list:bullet",
    "format:list:ordered",
    "format:list:task",
    "format:list:indent",
    "format:list:outdent",
    "format:align:left",
    "format:align:center",
    "format:align:right",
    "format:align:justify",
    "format:blockquote",
    "format:codeblock",
    "format:horizontalrule",
    "format:hardbreak",
    "format:link",
    "format:unlink",
    "format:undo",
    "format:redo",
    "format:table:insert",
    "format:table:delete",
    "format:table:addColumnBefore",
    "format:table:addColumnAfter",
    "format:table:deleteColumn",
    "format:table:addRowBefore",
    "format:table:addRowAfter",
    "format:table:deleteRow",
    "format:table:mergeCells",
    "format:table:splitCell",
    "format:table:toggleHeaderRow",
    "format:table:toggleHeaderColumn",
    "format:columns:2",
    "format:columns:3",
    "format:columns:4",
    "format:columns:delete",
    "format:clear",
    "format:color:text",
    "format:color:background",
    "format:color:clear",
  ];

  for (const id of actionIds) {
    Actions.unregister(id);
  }
}
