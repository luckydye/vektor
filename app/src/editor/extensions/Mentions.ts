import Mention from "@tiptap/extension-mention";

export type MentionOptions = {};

export const Mentions = Mention.extend<MentionOptions>({
  parseHTML() {
    return [
      {
        tag: "user-mention",
        getAttrs: (element: any) => {
          const email = element.getAttribute("email");
          const label = element.textContent?.replace("@", "") || email;
          return {
            id: email,
            label: label,
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "user-mention",
      {
        email: node.attrs.id,
      },
      `@${node.attrs.label || node.attrs.id}`,
    ];
  },

  addOptions() {
    return {
      ...this.parent?.(),
      HTMLAttributes: {
        class: "mention",
      },
    };
  },
});
