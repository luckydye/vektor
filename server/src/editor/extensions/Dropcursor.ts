import { Extension } from "@tiptap/core";
import { dropCursor } from "@tiptap/pm/dropcursor";

export type DropcursorOptions = {
  color?: string | false;
  width?: number;
  class?: string;
};

export const Dropcursor = Extension.create<DropcursorOptions>({
  name: "dropCursor",

  addOptions() {
    return {
      color: "currentColor",
      width: 1,
      class: undefined,
    };
  },

  addProseMirrorPlugins() {
    return [dropCursor(this.options)];
  },
});
