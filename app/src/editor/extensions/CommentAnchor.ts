import { Mark } from "@tiptap/core";
import { markFromSpec } from "./specSchema.ts";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    commentAnchor: {
      setCommentAnchor: (commentId: string) => ReturnType;
      unsetCommentAnchor: () => ReturnType;
    };
  }
}

export const CommentAnchor = Mark.create({
  name: "commentAnchor",
  ...markFromSpec("commentAnchor"),

  addCommands() {
    return {
      setCommentAnchor:
        (commentId: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { commentId }),
      unsetCommentAnchor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
