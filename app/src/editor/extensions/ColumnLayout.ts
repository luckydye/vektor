import type { CommandProps } from "@tiptap/core";
import { Node } from "@tiptap/core";
import { nodeFromSpec } from "./specSchema.ts";

export interface ColumnLayoutOptions {
  columns: number;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    columnLayout: {
      setColumnLayout: (options: { columns: number }) => ReturnType;
    };
  }
}

export const ColumnLayout = Node.create<ColumnLayoutOptions>({
  name: "columnLayout",
  ...nodeFromSpec("columnLayout"),

  addCommands() {
    return {
      setColumnLayout:
        (options: { columns: number }) =>
        ({ commands }: CommandProps) => {
          const { columns } = options;
          const columnItems = Array.from({ length: columns }, () => ({
            type: "columnItem",
            content: [{ type: "paragraph" }],
          }));

          return commands.insertContent({
            type: this.name,
            attrs: { columns },
            content: columnItems,
          });
        },
    };
  },
});

export const ColumnItem = Node.create({
  name: "columnItem",
  ...nodeFromSpec("columnItem"),
});
