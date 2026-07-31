import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  mergeProps,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { addAttachmentsIcon, deleteElementIcon, sendMessageIcon } from "#assets/icons.ts";
import { formatFileSize } from "#utils/utils.ts";
import "#editor/elements/rich-text-editor.ts";
import type {
  RichTextEditorElementApi,
  RichTextEditorFormat,
} from "#editor/elements/rich-text-editor.ts";

export type PendingAttachment = {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  previewUrl?: string;
};

/** Vue's `defineExpose`, as a callback prop (plan §10). */
export interface MessageInputHandle {
  focus: () => void;
  clearAttachments: () => void;
  removeAttachment: (id: string) => void;
  pendingAttachments: () => PendingAttachment[];
  el: () => HTMLElement | null;
}

interface Props {
  /** Two-way bound value. Solid spells this `value` + `onInput` (plan §10). */
  value: string;
  onInput?: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  rows?: number;
  autofocus?: boolean;
  autoGrow?: boolean;
  submitKey?: "enter" | "ctrl+enter";
  /** Externally disabled — blocks submit regardless of content (e.g. isGenerating, isUploading) */
  disabled?: boolean;
  /** Enable file attachment UI (drag-drop, paste, picker, previews) */
  attachments?: boolean;
  /** Show "Uploading files…" status (set by parent during API upload) */
  isUploading?: boolean;
  /** Upload error message from parent */
  uploadError?: string;
  /** Enable people and document @mention suggestions. */
  mentions?: boolean;
  /** Insert selected documents as agent-readable inline references. */
  inlineDocumentReferences?: boolean;
  spaceId?: string;
  documentId?: string;
  /** Vue's named slots. */
  left?: JSX.Element;
  actions?: JSX.Element;
  below?: JSX.Element;
  ref?: (handle: MessageInputHandle) => void;
}

export function MessageInput(props: Props) {
  const merged = mergeProps(
    {
      placeholder: "",
      rows: 1,
      autofocus: false,
      autoGrow: false,
      submitKey: "enter" as const,
      disabled: false,
      attachments: false,
      isUploading: false,
      uploadError: "",
      mentions: false,
      inlineDocumentReferences: false,
    },
    props,
  );

  const [editorElement, setEditorElement] = createSignal<RichTextEditorElementApi | null>(
    null,
  );
  let fileInputRef: HTMLInputElement | undefined;
  const [pendingAttachments, setPendingAttachments] = createStore<PendingAttachment[]>(
    [],
  );
  let lastEmittedValue = merged.value;

  const canSubmit = createMemo(
    () =>
      !merged.disabled &&
      (merged.value.trim().length > 0 || pendingAttachments.length > 0),
  );

  function focus() {
    editorElement()?.focus();
  }

  function toggleFormat(name: RichTextEditorFormat) {
    editorElement()?.toggleFormat(name);
  }

  // ── File management ─────────────────────────────────────────────────────────

  function revokePreviewUrl(url?: string) {
    if (url) URL.revokeObjectURL(url);
  }

  function clearAttachments() {
    for (const a of pendingAttachments) revokePreviewUrl(a.previewUrl);
    setPendingAttachments([]);
  }

  function removeAttachment(id: string) {
    const removed = pendingAttachments.find((a) => a.id === id);
    if (!removed) return;
    setPendingAttachments(
      produce((list) => {
        const idx = list.findIndex((a) => a.id === id);
        if (idx >= 0) list.splice(idx, 1);
      }),
    );
    revokePreviewUrl(removed.previewUrl);
  }

  function addFiles(fileList: FileList) {
    const next: PendingAttachment[] = [];
    for (const file of Array.from(fileList)) {
      next.push({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        previewUrl: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
      });
    }
    setPendingAttachments([...pendingAttachments, ...next]);
  }

  function onFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    addFiles(input.files);
    input.value = "";
  }

  function onDrop(event: DragEvent) {
    if (!merged.attachments || !event.dataTransfer?.files?.length || merged.disabled) {
      return;
    }
    event.preventDefault();
    addFiles(event.dataTransfer.files);
  }

  // ── Input events ────────────────────────────────────────────────────────────

  function onKeydown(event: KeyboardEvent) {
    // The editor may already have handled this key; do not act on it twice.
    if (event.defaultPrevented) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      toggleFormat("bold");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      toggleFormat("italic");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "Digit7") {
      event.preventDefault();
      toggleFormat("orderedList");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "Digit8") {
      event.preventDefault();
      toggleFormat("bulletList");
      return;
    }

    const isEnterNoShift = event.key === "Enter" && !event.shiftKey;
    const isCtrlEnter = event.key === "Enter" && event.ctrlKey;
    const editor = editorElement();
    const isInList = editor?.isActive("bulletList") || editor?.isActive("orderedList");
    const isMentionSuggestionOpen = editor?.isMentionSuggestionOpen();

    if (
      (merged.submitKey === "enter" &&
        isEnterNoShift &&
        !isInList &&
        !isMentionSuggestionOpen) ||
      (merged.submitKey === "ctrl+enter" && isCtrlEnter)
    ) {
      event.preventDefault();
      if (canSubmit()) merged.onSubmit?.();
    }
  }

  function onPaste(event: ClipboardEvent) {
    if (merged.attachments && !merged.disabled && event.clipboardData?.files?.length) {
      addFiles(event.clipboardData.files);
      event.preventDefault();
    }
  }

  onMount(() => {
    if (merged.autofocus) focus();
  });

  onCleanup(() => {
    for (const a of pendingAttachments) revokePreviewUrl(a.previewUrl);
  });

  createEffect(
    on(
      () => merged.value,
      (value) => {
        const editor = editorElement();
        if (!editor || value === lastEmittedValue) return;
        lastEmittedValue = value;
        editor.value = value;
      },
      { defer: true },
    ),
  );

  props.ref?.({
    focus,
    clearAttachments,
    removeAttachment,
    pendingAttachments: () => [...pendingAttachments],
    el: () => editorElement()?.el ?? null,
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drop surface wraps the editor; the editor and buttons inside are the controls.
    <div onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <Show when={merged.attachments}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          class="hidden"
          onChange={onFilesSelected}
        />
      </Show>

      {/* Pending attachment previews */}
      <Show when={merged.attachments && pendingAttachments.length > 0}>
        <div class="mb-2 flex flex-wrap gap-1.5">
          <For each={pendingAttachments}>
            {(attachment) => (
              <div class="group flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-10 px-1.5 py-1">
                <Show
                  when={attachment.previewUrl}
                  fallback={
                    <div class="flex h-8 w-8 items-center justify-center rounded-sm bg-neutral-200 font-semibold text-[10px] text-neutral-500">
                      FILE
                    </div>
                  }
                >
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    class="h-8 w-8 rounded-sm object-cover"
                  />
                </Show>
                <div class="min-w-0 max-w-36">
                  <p class="truncate text-neutral-700 text-size-small">
                    {attachment.name}
                  </p>
                  <p class="text-[10px] text-neutral-500">
                    {formatFileSize(attachment.size)}
                  </p>
                </div>
                <button
                  type="button"
                  class="text-neutral-400 transition-colors hover:text-red-500"
                  onClick={() => removeAttachment(attachment.id)}
                >
                  <div class="svg-icon h-3.5 w-3.5" innerHTML={deleteElementIcon} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Input row */}
      <div class="relative flex items-start gap-2 pr-7">
        {merged.left}

        <rich-text-editor
          ref={setEditorElement as never}
          prop:value={merged.value}
          attr:placeholder={merged.placeholder}
          attr:mentions={merged.mentions ? "" : undefined}
          attr:inline-document-references={
            merged.inlineDocumentReferences ? "" : undefined
          }
          attr:space-id={merged.spaceId}
          attr:document-id={merged.documentId}
          classList={{ "max-h-40": merged.autoGrow }}
          class="min-w-0 flex-1 overflow-y-auto bg-transparent text-neutral-800 text-size-medium leading-5"
          style={{ "--editor-min-height": `${Math.max(1, merged.rows) * 1.25}rem` }}
          on:content-change={(event: Event) => {
            const markdown = (event as CustomEvent<string>).detail;
            lastEmittedValue = markdown;
            merged.onInput?.(markdown);
          }}
          on:editor-keydown={(event: Event) =>
            onKeydown((event as CustomEvent<KeyboardEvent>).detail)
          }
          on:editor-paste={(event: Event) =>
            onPaste((event as CustomEvent<ClipboardEvent>).detail)
          }
        />

        <div class="absolute inset-y-0 right-0 flex w-5 flex-col items-center justify-between">
          <Show when={merged.attachments}>
            <button
              type="button"
              title="Attach files"
              class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-neutral-400 transition-colors hover:text-neutral-700"
              onClick={() => fileInputRef?.click()}
            >
              <div class="svg-icon h-4 w-4" innerHTML={addAttachmentsIcon} />
            </button>
          </Show>
          <Show
            when={merged.actions}
            fallback={
              <button
                type="button"
                disabled={!canSubmit()}
                class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-neutral-500 transition-colors hover:text-primary-500 disabled:opacity-40"
                title="Send"
                onClick={() => merged.onSubmit?.()}
              >
                <div class="svg-icon h-4 w-4" innerHTML={sendMessageIcon} />
              </button>
            }
          >
            {merged.actions}
          </Show>
        </div>
      </div>

      {/* Upload status (controlled by parent) */}
      <Show when={merged.attachments}>
        <Show when={merged.isUploading}>
          <p class="mt-2 text-neutral-500 text-size-small">Uploading files...</p>
        </Show>
        <Show when={merged.uploadError}>
          <p class="mt-2 text-red-600 text-size-small">{merged.uploadError}</p>
        </Show>
      </Show>

      {merged.below}
    </div>
  );
}
