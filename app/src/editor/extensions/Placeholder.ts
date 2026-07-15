import { type Editor, Extension, isNodeEmpty } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type PlaceholderContext = {
  editor: Editor;
  node: ProseMirrorNode;
  pos: number;
  hasAnchor: boolean;
};

export type PlaceholderOptions = {
  emptyEditorClass: string;
  emptyNodeClass: string;
  placeholder: string | ((context: PlaceholderContext) => string);
  showOnlyWhenEditable: boolean;
  showOnlyCurrent: boolean;
  includeChildren: boolean;
};

export const Placeholder = Extension.create<PlaceholderOptions>({
  name: "placeholder",

  addOptions() {
    return {
      emptyEditorClass: "is-editor-empty",
      emptyNodeClass: "is-empty",
      placeholder: "Write something …",
      showOnlyWhenEditable: true,
      showOnlyCurrent: true,
      includeChildren: false,
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("placeholder"),
        props: {
          decorations: ({ doc, selection }) => {
            if (this.options.showOnlyWhenEditable && !this.editor.isEditable) {
              return null;
            }

            const decorations: Decoration[] = [];
            const isEditorEmpty = this.editor.isEmpty;

            doc.descendants((node, pos) => {
              const hasAnchor =
                selection.anchor >= pos && selection.anchor <= pos + node.nodeSize;
              const shouldShow =
                !node.isLeaf &&
                isNodeEmpty(node) &&
                (hasAnchor || !this.options.showOnlyCurrent);

              if (shouldShow) {
                const classes = [this.options.emptyNodeClass];
                if (isEditorEmpty) classes.push(this.options.emptyEditorClass);

                const placeholder =
                  typeof this.options.placeholder === "function"
                    ? this.options.placeholder({
                        editor: this.editor,
                        node,
                        pos,
                        hasAnchor,
                      })
                    : this.options.placeholder;

                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: classes.join(" "),
                    "data-placeholder": placeholder,
                  }),
                );
              }

              return this.options.includeChildren;
            });

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },
});
