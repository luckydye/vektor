// Inline collaborative editor for a document embedded on the canvas. Mounted
// only for the embed the user activated, it joins the embedded document's own
// Yjs room and joins its presence room lazily — on the first editor focus — so
// idle embeds never hold an editor or appear as present.
//
// Was `CanvasDocumentEditor.vue`. Ported to a custom element via
// defineCustomElement so Canvas.vue is the only Vue component in the canvas
// tree, while keeping the Vue-backed collaboration/lifecycle logic intact.
// Light DOM (shadowRoot: false) so it uses the global .canvas-doc-editor styles
// and inherits the --canvas-* variables like the other canvas elements.
import type { Editor } from "@tiptap/core";
import {
  computed,
  defineCustomElement,
  h,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import type * as Y from "yjs";
import { documentIcon } from "#assets/icons.ts";
import { useCollaboration } from "#composeables/useCollaboration.ts";
import {
  currentEditorPresenceState,
  type DocumentPresenceProfile,
  type DocumentPresenceState,
} from "#editor/collaboration.ts";

type DocumentViewElement = HTMLElement & {
  editorInstance?: Editor;
  setEditorEnabled?: (enabled: boolean, ydoc?: Y.Doc) => void;
  setPresenceProfiles?: (profiles: DocumentPresenceProfile[]) => void;
};

const CanvasDocumentEditorElement = defineCustomElement(
  {
    props: {
      spaceId: { type: String, default: "" },
      documentId: { type: String, default: "" },
      title: { type: String, default: "" },
      headerImage: { type: String, default: "" },
      // When the edit session was started by clicking a checkbox on the
      // read-only card, this is that checkbox's ordinal so the toggle is
      // replayed in the editor (the read-only preview can't persist it).
      toggleTaskIndex: { type: Number, default: null },
    },
    emits: ["exit-edit", "drag-start"],
    setup(props, { emit, expose }) {
      const viewEl = shallowRef<DocumentViewElement | null>(null);
      const editor = shallowRef<Editor>();
      const status = ref<"connecting" | "ready" | "error">("connecting");
      const errorMessage = ref("");

      const collaboration = useCollaboration<DocumentPresenceState>({
        spaceId: props.spaceId,
        documentId: computed(() => props.documentId),
      });

      let leaveEditorSubscriptions: (() => void) | null = null;
      let pendingTaskToggle: number | null = props.toggleTaskIndex ?? null;

      // Toggle the checked state of the Nth task item, matching the checkbox
      // the user clicked on the read-only card. Task items render one checkbox
      // each in document order, so the ordinal maps directly onto the editor.
      function applyPendingTaskToggle(activeEditor: Editor) {
        const index = pendingTaskToggle;
        pendingTaskToggle = null;
        if (index === null || index < 0) return;

        const positions: number[] = [];
        activeEditor.state.doc.descendants((node, pos) => {
          if (node.type.name === "taskItem") positions.push(pos);
        });
        const pos = positions[index];
        if (pos === undefined) return;

        activeEditor
          .chain()
          .command(({ tr }) => {
            const node = tr.doc.nodeAt(pos);
            if (node?.type.name !== "taskItem") return false;
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              checked: !node.attrs.checked,
            });
            return true;
          })
          .run();
      }

      function broadcastEditorPresence() {
        const state = currentEditorPresenceState(editor.value);
        collaboration.setPresenceState(state);
        // Join the presence room only once the editor actually holds focus.
        if (state.focused) void collaboration.setupPresence();
        collaboration.updatePresence();
      }

      function setEditor(nextEditor: Editor | undefined) {
        if (editor.value === nextEditor) return;

        leaveEditorSubscriptions?.();
        leaveEditorSubscriptions = null;
        editor.value = nextEditor;
        if (!nextEditor) return;

        applyPendingTaskToggle(nextEditor);

        nextEditor.on("focus", broadcastEditorPresence);
        nextEditor.on("blur", broadcastEditorPresence);
        nextEditor.on("selectionUpdate", broadcastEditorPresence);
        nextEditor.on("transaction", broadcastEditorPresence);
        broadcastEditorPresence();

        leaveEditorSubscriptions = () => {
          nextEditor.off("focus", broadcastEditorPresence);
          nextEditor.off("blur", broadcastEditorPresence);
          nextEditor.off("selectionUpdate", broadcastEditorPresence);
          nextEditor.off("transaction", broadcastEditorPresence);
        };
      }

      watch(
        viewEl,
        (view, _previousView, onCleanup) => {
          if (!view) return;

          view.setEditorEnabled?.(true, collaboration.ydoc.value);
          setEditor(view.editorInstance);

          const handleEditorReady = (event: Event) => {
            setEditor((event as CustomEvent<{ editor: Editor }>).detail.editor);
          };
          const handleEditorDestroyed = () => {
            setEditor(undefined);
          };

          view.addEventListener("editor-ready", handleEditorReady);
          view.addEventListener("editor-destroyed", handleEditorDestroyed);
          onCleanup(() => {
            view.removeEventListener("editor-ready", handleEditorReady);
            view.removeEventListener("editor-destroyed", handleEditorDestroyed);
          });
        },
        { immediate: true },
      );

      watch(
        [collaboration.presenceProfiles, editor],
        ([profiles]) => {
          viewEl.value?.setPresenceProfiles?.(profiles);
        },
        { immediate: true },
      );

      let disposed = false;

      onMounted(async () => {
        try {
          // document-view is loaded lazily so the canvas chunk stays lean;
          // Canvas prefetches it on mount, making this await effectively instant.
          await import("#editor/document.ts");
          await customElements.whenDefined("document-view");
          await collaboration.joinUntilReady();
          if (disposed) return;
          status.value = "ready";
        } catch (error) {
          if (disposed) return;
          status.value = "error";
          errorMessage.value = error instanceof Error ? error.message : String(error);
        }
      });

      onBeforeUnmount(() => {
        disposed = true;
        setEditor(undefined);
        viewEl.value?.setEditorEnabled?.(false);
      });

      function onKeydown(event: KeyboardEvent) {
        // Keep typing from triggering canvas shortcuts (tool switches, Delete).
        event.stopPropagation();
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          // Collaborative edits persist automatically; swallow the save dialog.
          event.preventDefault();
          return;
        }
        if (event.key === "Escape") emit("exit-edit");
      }

      expose({
        getHtml(): string | null {
          return editor.value?.getHTML() ?? null;
        },
      });

      const stop = (event: Event) => event.stopPropagation();

      return () =>
        h(
          "div",
          {
            class: "canvas-doc-editor",
            onPointerdown: stop,
            onDblclick: stop,
            onContextmenu: stop,
            onWheel: stop,
            onKeydown,
            onKeyup: stop,
            onCopy: stop,
            onCut: stop,
            onPaste: stop,
          },
          [
            h(
              "div",
              {
                class: "editor-header",
                onPointerdown: (event: PointerEvent) => {
                  event.stopPropagation();
                  emit("drag-start", event);
                },
              },
              [
                h("span", {
                  class: "svg-icon icon",
                  "aria-hidden": "true",
                  innerHTML: documentIcon,
                }),
                h("span", { class: "title-wrap" }, [
                  h("span", { class: "title" }, props.title),
                ]),
                h(
                  "button",
                  {
                    type: "button",
                    class: "done",
                    onPointerdown: stop,
                    onClick: () => emit("exit-edit"),
                  },
                  "Done",
                ),
              ],
            ),
            props.headerImage
              ? h("div", { class: "editor-header-image-frame" }, [
                  h("img", {
                    class: "editor-header-image",
                    src: props.headerImage,
                    alt: "",
                    draggable: false,
                  }),
                ])
              : null,
            h("div", { class: "editor-body" }, [
              status.value === "connecting"
                ? h("p", { class: "editor-hint" }, "Connecting…")
                : status.value === "error"
                  ? h(
                      "p",
                      { class: "editor-hint" },
                      errorMessage.value || "Unable to open the editor.",
                    )
                  : h("document-view", {
                      ref: viewEl,
                      "space-id": props.spaceId,
                      "document-id": props.documentId,
                    }),
            ]),
          ],
        );
    },
  },
  { shadowRoot: false },
);

if (
  typeof customElements !== "undefined" &&
  !customElements.get("canvas-document-editor")
) {
  customElements.define("canvas-document-editor", CanvasDocumentEditorElement);
}
