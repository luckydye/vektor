import { useLocation, useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { boltIcon, canvasIcon, databaseIcon, documentIcon } from "#assets/icons.ts";
import canvasPreview from "#assets/new-document-picker/canvas-preview.svg?raw";
import documentPreview from "#assets/new-document-picker/document-preview.svg?raw";
import { useSpace } from "#composeables/useSpace.solid.ts";
import { type TranslationKey, t } from "#utils/lang.ts";
import { isWorkflowCreationEnabled } from "#utils/spacePreferences.ts";

type DocumentType = "document" | "canvas" | "workflow" | "database";

const documentOptions: Array<{
  type: DocumentType;
  title: TranslationKey;
  description: TranslationKey;
  icon: string;
  illustration?: string;
}> = [
  {
    type: "document",
    title: "Doc",
    description: "Write, organize, and collaborate in a structured document.",
    icon: documentIcon,
    illustration: documentPreview,
  },
  {
    type: "canvas",
    title: "Canvas",
    description: "Visualize ideas and connect things on a flexible canvas.",
    icon: canvasIcon,
    illustration: canvasPreview,
  },
  {
    type: "workflow",
    title: "Workflow",
    description: "Map steps and automate processes with ease.",
    icon: boltIcon,
  },
  {
    type: "database",
    title: "Database",
    description: "Organize and manage data in structured tables.",
    icon: databaseIcon,
  },
];

export function NewDocumentPicker() {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentSpace } = useSpace();
  const [visible, setVisible] = createSignal(true);

  const availableDocumentOptions = createMemo(() =>
    documentOptions.filter(
      (option) =>
        option.type !== "workflow" ||
        isWorkflowCreationEnabled(currentSpace()?.preferences),
    ),
  );

  function focusEditor() {
    const editorEl = document.querySelector("document-view") as HTMLElement | null;
    editorEl?.focus();
  }

  function selectType(type: DocumentType) {
    if (type === "document") {
      setVisible(false);
      focusEditor();
      return;
    }
    const query = new URLSearchParams(location.search);
    query.set("type", type);
    navigate(`/new?${query.toString()}`);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!visible()) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      setVisible(false);
      focusEditor();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    });
  });

  return (
    <div
      hidden={!visible()}
      role="dialog"
      class="overlay-fade pointer-events-none relative z-10 flex justify-center pt-6 pb-8"
      aria-label={t("Select document type")}
    >
      <div class="new-document-picker pointer-events-auto w-full max-w-[1120px] opacity-80 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100">
        <div class="mb-8 flex flex-col items-center text-center">
          <p class="mt-2 text-neutral-500 text-size-large">
            {t("Choose a format to get started.")}
          </p>
        </div>

        <div class="grid grid-cols-1 gap-3 md:gap-4 xl:grid-cols-2">
          <For each={availableDocumentOptions()}>
            {(option) => (
              <button
                type="button"
                class="group grid min-h-[154px] cursor-pointer gap-5 rounded-lg border border-neutral-200 bg-neutral-10 p-5 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 max-sm:grid-cols-1 max-sm:p-4"
                onClick={() => selectType(option.type)}
              >
                <span class="flex min-w-0 items-start gap-4">
                  <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700 transition-colors group-hover:bg-primary-100">
                    <span class="svg-icon h-6 w-6" innerHTML={option.icon} />
                  </span>
                  <span class="min-w-0 pt-1">
                    <span class="block font-semibold text-[21px] text-neutral-900 leading-7">
                      {t(option.title)}
                    </span>
                    <span class="mt-1 block max-w-[240px] text-neutral-500 text-size-medium leading-6">
                      {t(option.description)}
                    </span>
                  </span>
                </span>

                <Show when={option.illustration}>
                  {(illustration) => (
                    <span
                      class="block min-h-[116px] overflow-hidden max-[640px]:hidden [&_svg]:block [&_svg]:h-full [&_svg]:w-full"
                      aria-hidden="true"
                      innerHTML={illustration()}
                    />
                  )}
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
