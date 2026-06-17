import { Mark } from "@tiptap/core";

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

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-comment-id"),
        renderHTML: (attributes) => {
          if (!attributes.commentId) return {};
          return { "data-comment-id": attributes.commentId };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", { ...HTMLAttributes, class: "comment-anchor" }, 0];
  },

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
