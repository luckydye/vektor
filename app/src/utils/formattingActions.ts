import { Actions } from "./actions";

/**
 * Get the global editor instance
 */
const getEditor = () => {
  return (globalThis as any).__editor;
};

/**
 * Check if editor is available and focused
 */
const isEditorAvailable = () => {
  const editor = getEditor();
  return editor && !editor.isDestroyed;
};

/**
 * Register all formatting actions
 */
export function registerFormattingActions() {
  // Text formatting
  Actions.register("format:bold", {
    title: "Bold",
    description: "Toggle bold formatting",
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleBold().run();
    },
  });

  Actions.register("format:italic", {
    title: "Italic",
    description: "Toggle italic formatting",
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleItalic().run();
    },
  });

  Actions.register("format:underline", {
    title: "Underline",
    description: "Toggle underline formatting",
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleUnderline().run();
    },
  });

  Actions.register("format:strikethrough", {
    title: "Strikethrough",
    description: "Toggle strikethrough formatting",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleStrike().run();
    },
  });

  Actions.register("format:code", {
    title: "Inline Code",
    description: "Toggle inline code formatting",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleCode().run();
    },
  });

  Actions.register("format:subscript", {
    title: "Subscript",
    description: "Toggle subscript formatting",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleSubscript().run();
    },
  });

  Actions.register("format:superscript", {
    title: "Superscript",
    description: "Toggle superscript formatting",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleSuperscript().run();
    },
  });

  // Headings
  Actions.register("format:heading:paragraph", {
    title: "Paragraph",
    description: "Convert to normal paragraph",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setParagraph().run();
    },
  });

  Actions.register("format:heading:1", {
    title: "Heading 1",
    description: "Convert to heading level 1",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 1 }).run();
    },
  });

  Actions.register("format:heading:2", {
    title: "Heading 2",
    description: "Convert to heading level 2",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 2 }).run();
    },
  });

  Actions.register("format:heading:3", {
    title: "Heading 3",
    description: "Convert to heading level 3",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 3 }).run();
    },
  });

  Actions.register("format:heading:4", {
    title: "Heading 4",
    description: "Convert to heading level 4",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 4 }).run();
    },
  });

  Actions.register("format:heading:5", {
    title: "Heading 5",
    description: "Convert to heading level 5",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 5 }).run();
    },
  });

  Actions.register("format:heading:6", {
    title: "Heading 6",
    description: "Convert to heading level 6",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeading({ level: 6 }).run();
    },
  });

  // Lists
  Actions.register("format:list:bullet", {
    title: "Bullet List",
    description: "Toggle bullet list",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleBulletList().run();
    },
  });

  Actions.register("format:list:ordered", {
    title: "Numbered List",
    description: "Toggle numbered list",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleOrderedList().run();
    },
  });

  Actions.register("format:list:task", {
    title: "Task List",
    description: "Toggle task/checkbox list",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleTaskList().run();
    },
  });

  Actions.register("format:list:indent", {
    title: "Indent List Item",
    description: "Indent the current list item",
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
    title: "Outdent List Item",
    description: "Outdent the current list item",
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
    title: "Align Left",
    description: "Align text to the left",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setTextAlign("left").run();
    },
  });

  Actions.register("format:align:center", {
    title: "Align Center",
    description: "Center align text",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setTextAlign("center").run();
    },
  });

  Actions.register("format:align:right", {
    title: "Align Right",
    description: "Align text to the right",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setTextAlign("right").run();
    },
  });

  Actions.register("format:align:justify", {
    title: "Justify",
    description: "Justify text alignment",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setTextAlign("justify").run();
    },
  });

  // Block elements
  Actions.register("format:blockquote", {
    title: "Blockquote",
    description: "Toggle blockquote",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleBlockquote().run();
    },
  });

  Actions.register("format:codeblock", {
    title: "Code Block",
    description: "Toggle code block",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleCodeBlock().run();
    },
  });

  Actions.register("format:horizontalrule", {
    title: "Horizontal Rule",
    description: "Insert horizontal divider line",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().setHorizontalRule().run();
    },
  });

  // Links
  Actions.register("format:link", {
    title: "Insert Link",
    description: "Add or edit a hyperlink",
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
    title: "Remove Link",
    description: "Remove hyperlink from selection",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().unsetLink().run();
    },
  });

  // History
  Actions.register("format:undo", {
    title: "Undo",
    description: "Undo the last action",
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().undo().run();
    },
  });

  Actions.register("format:redo", {
    title: "Redo",
    description: "Redo the last undone action",
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().redo().run();
    },
  });

  // Table operations
  Actions.register("format:table:insert", {
    title: "Insert Table",
    description: "Insert a new table",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    },
  });

  Actions.register("format:table:delete", {
    title: "Delete Table",
    description: "Delete the current table",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().deleteTable().run();
    },
  });

  Actions.register("format:table:addColumnBefore", {
    title: "Add Column Before",
    description: "Add a column before the current one",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().addColumnBefore().run();
    },
  });

  Actions.register("format:table:addColumnAfter", {
    title: "Add Column After",
    description: "Add a column after the current one",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().addColumnAfter().run();
    },
  });

  Actions.register("format:table:deleteColumn", {
    title: "Delete Column",
    description: "Delete the current column",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().deleteColumn().run();
    },
  });

  Actions.register("format:table:addRowBefore", {
    title: "Add Row Before",
    description: "Add a row before the current one",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().addRowBefore().run();
    },
  });

  Actions.register("format:table:addRowAfter", {
    title: "Add Row After",
    description: "Add a row after the current one",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().addRowAfter().run();
    },
  });

  Actions.register("format:table:deleteRow", {
    title: "Delete Row",
    description: "Delete the current row",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().deleteRow().run();
    },
  });

  Actions.register("format:table:mergeCells", {
    title: "Merge Cells",
    description: "Merge selected cells",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().mergeCells().run();
    },
  });

  Actions.register("format:table:splitCell", {
    title: "Split Cell",
    description: "Split the current cell",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().splitCell().run();
    },
  });

  Actions.register("format:table:toggleHeaderRow", {
    title: "Toggle Header Row",
    description: "Toggle the header row of the table",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeaderRow().run();
    },
  });

  Actions.register("format:table:toggleHeaderColumn", {
    title: "Toggle Header Column",
    description: "Toggle the header column of the table",
    group: "table",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().toggleHeaderColumn().run();
    },
  });

  // Column layout
  Actions.register("format:columns:2", {
    title: "2 Columns",
    description: "Insert or set 2-column layout",
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
    title: "3 Columns",
    description: "Insert or set 3-column layout",
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
    title: "4 Columns",
    description: "Insert or set 4-column layout",
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
    title: "Delete Column Layout",
    description: "Remove the column layout",
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
    title: "Clear Formatting",
    description: "Remove all formatting from selection",
    group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      getEditor().chain().focus().clearNodes().unsetAllMarks().run();
    },
  });

  // Text color (these require user input, so they just focus the relevant input)
  Actions.register("format:color:text", {
    title: "Text Color",
    description: "Change text color",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      // This action triggers an event that the toolbar can listen to
      Actions.emit("format:color:text:open", {});
    },
  });

  Actions.register("format:color:background", {
    title: "Background Color",
    description: "Change text background color",
    // group: "formatting",
    run: async () => {
      if (!isEditorAvailable()) return;
      Actions.emit("format:color:background:open", {});
    },
  });

  Actions.register("format:color:clear", {
    title: "Clear Background Color",
    description: "Remove background color from text",
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
function setColumnCount(editor: any, newCount: number) {
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
            editor.schema.nodes.paragraph.create()
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