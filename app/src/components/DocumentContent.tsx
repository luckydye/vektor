import type { Editor } from "@tiptap/core";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { isServer } from "solid-js/web";
import type * as Y from "yjs";
import { api } from "#api/client.ts";
import { useQuery } from "#composeables/query.ts";
import {
  type CollaborationPresenceProfile,
  provideCollaboration,
  useCollaboration,
} from "#composeables/useCollaboration.ts";
import { useCosmetics } from "#composeables/useCosmetics.ts";
import {
  resetEditingState,
  setEditing,
  setHasChanges,
  useEditor,
} from "#composeables/useEditor.ts";
import { useInlineSuggestions } from "#composeables/useInlineSuggestions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useSync } from "#composeables/useSync.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import type { PublicUserAppearance } from "#cosmetics/types.ts";
import { supportsComments, supportsDocumentEditor } from "#documents/types.ts";
import { setActiveEditor } from "#editor/activeEditor.ts";
import {
  currentEditorPresenceState,
  type DocumentPresenceProfile,
  type DocumentPresenceState,
} from "#editor/collaboration.ts";
import { renderDocumentReadShadowHtml } from "#editor/readView.ts";
import {
  registerFormattingActions,
  unregisterFormattingActions,
} from "#editor/formattingActions.ts";
import { extensions } from "#extensions/manager.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { Actions } from "#utils/actions.ts";
import { CommentBubble, type CommentBubbleHandle } from "./CommentBubble.tsx";
import { CommentOverlays } from "./CommentOverlays.tsx";
import "#editor/elements/toolbar.ts";
import "#components/document-statusbar.ts";

type TaskToggleRequest = { index: number };

interface Props {
  documentId?: string;
  initialHtml?: string;
  documentType?: string;
  readonly?: boolean;
  spaceId: string;
}

type DocumentViewElement = HTMLElement & {
  editorInstance?: Editor;
  collaborationDocument?: Y.Doc;
  destroyEditor?: () => void;
  setEditorEnabled?: (enabled: boolean, ydoc?: Y.Doc) => void;
  renderReadHtml?: (html: string) => void;
  setPresenceProfiles?: (profiles: DocumentPresenceProfile[]) => void;
  setLocalAppearance?: (appearance: PublicUserAppearance | undefined) => void;
};

type DocumentToolbarElement = HTMLElement & {
  editor?: Editor;
  dismiss?: () => void;
  openTextColorPicker?: () => void;
  openBackgroundColorPicker?: () => void;
};

export function DocumentContent(props: Props) {
  const t = useTranslation();
  const lang = useLocale();
  const documentId = createMemo(() => props.documentId);
  const documentType = createMemo(() => props.documentType || "document");
  const documentReadonly = createMemo(() => props.readonly ?? false);
  const supportsRichTextDocument = createMemo(() =>
    supportsDocumentEditor(documentType()),
  );

  const { currentSpaceId } = useSpace();
  const [pendingReload, setPendingReload] = createSignal(false);
  const [renderedHtml, setRenderedHtml] = createSignal(props.initialHtml || "");
  const [commentBubble, setCommentBubble] = createSignal<CommentBubbleHandle | null>(
    null,
  );

  const [documentViewEl, setDocumentViewEl] = createSignal<DocumentViewElement | null>(
    null,
  );
  const [documentToolbar, setDocumentToolbar] =
    createSignal<DocumentToolbarElement | null>(null);
  const [editor, setEditor] = createSignal<Editor | undefined>();
  const { appearance: localAppearance } = useCosmetics();
  let pendingTaskToggle: number | null = null;

  function requestTaskToggle(event: Event) {
    pendingTaskToggle = (event as CustomEvent<TaskToggleRequest>).detail.index;
  }

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
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked });
        return true;
      })
      .run();
  }

  const handleVisibilityChange = () => {
    if (pendingReload() && document.visibilityState === "visible") {
      setPendingReload(false);
      reloadIfReady();
    }
  };

  resetEditingState();

  createEffect(
    on(documentId, (currentDocumentId, previousDocumentId) => {
      if (currentDocumentId === previousDocumentId) return;
      autoEditModeApplied = false;
      resetEditingState();
      maybeStartAutoEditMode();
    }),
  );

  const collaboration = useCollaboration<DocumentPresenceState>({
    spaceId: props.spaceId,
    documentId,
  });
  provideCollaboration(collaboration);

  const {
    editing,
    cancelCount,
    shouldMountEditor,
    canMountEditor,
    suggestionSavedCount,
  } = useEditor({
    spaceId: props.spaceId,
    documentId,
    documentType,
    readonly: documentReadonly,
    getEditorHtml: () => editor()?.getHTML() ?? null,
    collaboration,
    onSessionStarted: handleEditSessionStarted,
  });

  const { handleInlineSuggestionAccept, handleInlineSuggestionDecline } =
    useInlineSuggestions({
      spaceId: currentSpaceId,
      documentId,
      isEditing: editing,
      editor,
    });

  function currentPresenceState(): DocumentPresenceState {
    return currentEditorPresenceState(editor());
  }

  let leaveEditorPresenceSubscriptions: (() => void) | null = null;

  function setupDocumentPresence() {
    if (!documentId() || !supportsRichTextDocument()) {
      collaboration.clearPresence();
      return;
    }

    collaboration.setPresenceState(currentPresenceState());
    void collaboration.setupPresence();
  }

  function handleEditSessionStarted() {
    setupDocumentPresence();
  }

  function clearEditorPresenceSubscriptions() {
    leaveEditorPresenceSubscriptions?.();
    leaveEditorPresenceSubscriptions = null;
  }

  function setCurrentEditor(nextEditor: Editor | undefined) {
    if (editor() === nextEditor) return;

    clearEditorPresenceSubscriptions();
    setEditor(() => nextEditor);
    const toolbar = documentToolbar();
    if (toolbar) toolbar.editor = nextEditor;
    setActiveEditor(nextEditor ?? null);

    if (!nextEditor) {
      collaboration.updatePresence(currentPresenceState());
      return;
    }

    const updatePresence = () => {
      collaboration.updatePresence(currentPresenceState());
    };

    const trackLocalChange = ({
      transaction,
    }: {
      transaction: { docChanged: boolean; getMeta: (key: string) => unknown };
    }) => {
      if (transaction.docChanged && !transaction.getMeta("y-sync$")) {
        setHasChanges(true);
      }
    };

    nextEditor.on("selectionUpdate", updatePresence);
    nextEditor.on("focus", updatePresence);
    nextEditor.on("blur", updatePresence);
    nextEditor.on("transaction", updatePresence);
    nextEditor.on("update", trackLocalChange as Parameters<typeof nextEditor.on>[1]);
    applyPendingTaskToggle(nextEditor);
    updatePresence();

    leaveEditorPresenceSubscriptions = () => {
      nextEditor.off("selectionUpdate", updatePresence);
      nextEditor.off("focus", updatePresence);
      nextEditor.off("blur", updatePresence);
      nextEditor.off("transaction", updatePresence);
      nextEditor.off("update", trackLocalChange as Parameters<typeof nextEditor.on>[1]);
    };
  }

  const { data: documentData, refetch: refreshDocument } = useQuery({
    queryKey: createMemo(() => ["wiki_document", currentSpaceId(), documentId()]),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) throw new Error("No space ID");
      const docId = documentId();
      if (!docId) return null;
      return await api.document.get(spaceId, docId);
    },
    enabled: createMemo(() => !!currentSpaceId() && !!documentId()),
  });

  function reloadIfReady() {
    if (editing()) return;
    if (!documentId()) return;
    refreshDocument();
  }

  createEffect(
    on(
      cancelCount,
      () => {
        const content = documentData()?.content;
        if (typeof content === "string") setRenderedHtml(content);
        documentViewEl()?.renderReadHtml?.(renderedHtml());
        reloadIfReady();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      suggestionSavedCount,
      () => {
        refreshDocument();
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const editorProfiles = collaboration
      .presenceProfiles()
      .filter(
        (profile): profile is CollaborationPresenceProfile<DocumentPresenceState> =>
          profile.state?.kind === "editor",
      );
    documentViewEl()?.setPresenceProfiles?.(editorProfiles);
  });

  createEffect(() => {
    documentViewEl()?.setLocalAppearance?.(localAppearance());
  });

  createEffect(() => {
    const toolbar = documentToolbar();
    if (toolbar) toolbar.editor = editor();
  });

  createEffect(() => {
    const view = documentViewEl();
    if (!view) return;

    const ydoc = collaboration.ydoc();
    const enabled = shouldMountEditor() && canMountEditor();
    if (view.setEditorEnabled) {
      view.setEditorEnabled(enabled, ydoc);
      return;
    }

    view.collaborationDocument = ydoc;
    if (enabled) view.setAttribute("editor", "");
    else view.removeAttribute("editor");
  });

  createEffect(() => {
    const view = documentViewEl();
    setCurrentEditor(view?.editorInstance);
    if (!view) return;

    const handleEditorReady = (event: Event) => {
      setCurrentEditor((event as CustomEvent<{ editor: Editor }>).detail.editor);
    };
    const handleEditorDestroyed = (event: Event) => {
      const destroyedEditor = (event as CustomEvent<{ editor: Editor }>).detail.editor;
      if (editor() === destroyedEditor) setCurrentEditor(undefined);
    };

    view.addEventListener("editor-ready", handleEditorReady);
    view.addEventListener("editor-destroyed", handleEditorDestroyed);
    onCleanup(() => {
      view.removeEventListener("editor-ready", handleEditorReady);
      view.removeEventListener("editor-destroyed", handleEditorDestroyed);
    });
  });

  let toolbarActionsRegistered = false;
  let leaveToolbarActionSubscriptions: Array<() => void> = [];
  let formattingActionsRegistered = false;
  let autoEditModeApplied = false;

  function registerEditorActions() {
    if (formattingActionsRegistered) return;

    registerFormattingActions(() => editor() as Editor, lang);
    formattingActionsRegistered = true;
  }

  function unregisterEditorActions() {
    if (!formattingActionsRegistered) return;

    unregisterFormattingActions();
    formattingActionsRegistered = false;
  }

  function registerToolbarActions() {
    if (toolbarActionsRegistered) return;

    Actions.register("toolbar:dismiss", {
      title: "Dismiss toolbar",
      description: "Hide the editor toolbar",
      group: "formatting",
      run: async () => {
        documentToolbar()?.dismiss?.();
      },
    });
    Actions.mapShortcut("escape", "toolbar:dismiss");
    leaveToolbarActionSubscriptions = [
      Actions.subscribe("format:color:text:open", () => {
        documentToolbar()?.openTextColorPicker?.();
      }),
      Actions.subscribe("format:color:background:open", () => {
        documentToolbar()?.openBackgroundColorPicker?.();
      }),
    ];
    toolbarActionsRegistered = true;
  }

  function unregisterToolbarActions() {
    if (!toolbarActionsRegistered) return;

    Actions.unmapShortcut("escape", "toolbar:dismiss");
    Actions.unregister("toolbar:dismiss");
    for (const leave of leaveToolbarActionSubscriptions) leave();
    leaveToolbarActionSubscriptions = [];
    toolbarActionsRegistered = false;
  }

  function shouldAutoStartEditMode() {
    if (!canMountEditor()) return false;
    if (!documentId()) return true;
    return documentData()?.publishedRev === null;
  }

  function maybeStartAutoEditMode() {
    if (autoEditModeApplied || !shouldAutoStartEditMode()) return;
    autoEditModeApplied = true;
    setEditing(true);
  }

  createEffect(
    on(
      editing,
      (isEditing) => {
        if (isEditing) {
          registerEditorActions();
          registerToolbarActions();
        } else {
          pendingTaskToggle = null;
          unregisterEditorActions();
          unregisterToolbarActions();
        }
      },
      { defer: true },
    ),
  );

  onMount(() => {
    extensions.setActiveCollaboration(collaboration.ydoc());
    extensions.setActiveDocumentId(documentId() ?? null);

    window.addEventListener("inline-suggestion:accept", handleInlineSuggestionAccept);
    window.addEventListener("inline-suggestion:decline", handleInlineSuggestionDecline);
    window.addEventListener("visibilitychange", handleVisibilityChange);

    maybeStartAutoEditMode();
  });

  onCleanup(() => {
    if (isServer) return;
    extensions.setActiveCollaboration(null);
    extensions.setActiveDocumentId(null);
    setCurrentEditor(undefined);
    collaboration.clearPresence();
    unregisterEditorActions();
    unregisterToolbarActions();
    setActiveEditor(null);
    window.removeEventListener("inline-suggestion:accept", handleInlineSuggestionAccept);
    window.removeEventListener(
      "inline-suggestion:decline",
      handleInlineSuggestionDecline,
    );
    window.removeEventListener("visibilitychange", handleVisibilityChange);
  });

  createEffect(
    on(documentData, (doc) => {
      if (!doc) return;
      if (typeof doc.content === "string") setRenderedHtml(doc.content);
      maybeStartAutoEditMode();
      const layout = Array.isArray(doc.properties?.layout)
        ? doc.properties.layout[0]
        : doc.properties?.layout;
      const full = layout === "full";
      const container = document.querySelector<HTMLElement>("[data-layout]");
      container?.classList.toggle("max-w-full", full);
      container?.classList.toggle("max-w-(--document-width)", !full);
    }),
  );

  const ssrDeclarativeShadowDom = createMemo(() => {
    if (!isServer) return "";
    return renderDocumentReadShadowHtml(renderedHtml(), {
      readonly: documentReadonly(),
    });
  });

  useSync(
    currentSpaceId,
    () => {
      const docId = documentId();
      return docId ? [realtimeTopics.document(docId)] : [];
    },
    (scopes) => {
      const docId = documentId();
      if (!docId) return;
      if (!scopes.includes(realtimeTopics.document(docId))) return;

      if (document.visibilityState === "visible") reloadIfReady();
      else setPendingReload(true);
    },
  );

  return (
    <>
      <main class="relative mb-30">
        <Show when={supportsRichTextDocument()}>
          <div classList={{ "h-full": editing() }}>
            <document-view
              ref={setDocumentViewEl as never}
              prop:html={renderedHtml()}
              attr:space-id={props.spaceId}
              attr:document-id={documentId()}
              attr:readonly={documentReadonly() ? "" : undefined}
              data-allow-mismatch="children"
              on:task-toggle-request={requestTaskToggle}
              innerHTML={ssrDeclarativeShadowDom()}
            />
          </div>
        </Show>

        <div></div>
      </main>

      <Show when={documentId() && supportsComments(documentType())}>
        {(_) => {
          const docId = documentId();
          if (!docId) return null;
          return (
            <>
              <CommentBubble
                ref={setCommentBubble}
                spaceId={props.spaceId}
                documentId={docId}
                currentRev={documentData()?.currentRev}
                editor={editor()}
                documentView={documentViewEl()}
              />
              <CommentOverlays
                comments={commentBubble()?.commentsForOverlays() ?? []}
                activeReference={commentBubble()?.activeReference() ?? null}
                onMove={(payload) => void commentBubble()?.handleMoveThread(payload)}
                onPositioned={() => commentBubble()?.handleThreadReposition()}
              />
            </>
          );
        }}
      </Show>

      <Show when={editing() && canMountEditor()}>
        <document-statusbar class="pointer-events-none fixed inset-x-0 bottom-0 z-10 mx-auto hidden max-w-[calc(var(--document-width)+1.5rem)] overflow-hidden px-xs pb-5 md:right-(--inset-right) md:left-(--inset-left) md:block lg:px-xl" />
      </Show>

      <document-toolbar
        ref={setDocumentToolbar as never}
        attr:data-comments-enabled={supportsComments(documentType()) ? "" : undefined}
      />
    </>
  );
}
