import { useLocation, useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useSpace } from "#composeables/useSpace.ts";
import { useTemplates } from "#composeables/useTemplates.ts";
import { useToast } from "#composeables/useToast.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import type { DocumentTemplate } from "#documents/templates.ts";
import { insertTemplateContent } from "#editor/templates.ts";
import type { TranslationKey } from "#utils/lang.ts";
import {
  isRepositoryCreationEnabled,
  isWorkflowCreationEnabled,
} from "#utils/spacePreferences.ts";
import { Icon, type IconName } from "./Icon.tsx";

type DocumentType = "canvas" | "workflow" | "database" | "repository";

const documentOptions: Array<{
  type: DocumentType;
  title: TranslationKey;
  description: TranslationKey;
  icon: IconName;
}> = [
  {
    type: "canvas",
    title: "Canvas",
    description: "Visualize ideas and connect things on a flexible canvas.",
    icon: "canvas",
  },
  {
    type: "workflow",
    title: "Workflow",
    description: "Map steps and automate processes with ease.",
    icon: "bolt",
  },
  {
    type: "database",
    title: "Database",
    description: "Organize and manage data in structured tables.",
    icon: "database",
  },
  {
    type: "repository",
    title: "Repository",
    description: "Host code with git, and browse it here.",
    icon: "repository",
  },
];

export function NewDocumentPicker() {
  const t = useTranslation();

  const navigate = useNavigate();
  const location = useLocation();
  const { currentSpace } = useSpace();
  const { templates } = useTemplates();
  const toast = useToast();
  const [visible, setVisible] = createSignal(true);

  const availableDocumentOptions = createMemo(() =>
    documentOptions.filter((option) => {
      if (option.type === "workflow") {
        return isWorkflowCreationEnabled(currentSpace()?.preferences);
      }
      if (option.type === "repository") {
        return isRepositoryCreationEnabled(currentSpace()?.preferences);
      }
      return true;
    }),
  );

  function focusEditor() {
    const editorEl = document.querySelector("document-view") as HTMLElement | null;
    editorEl?.focus();
  }

  function selectType(type: DocumentType) {
    const query = new URLSearchParams(location.search);
    query.set("type", type);
    navigate(`/new?${query.toString()}`);
  }

  /**
   * A template is content, not a document kind: picking one leaves the user in
   * the same empty draft they already started, with the template body written
   * into it. Nothing is created until they save, and nothing stops them from
   * adding a second template underneath.
   */
  async function selectTemplate(template: DocumentTemplate) {
    setVisible(false);
    focusEditor();

    if (!(await insertTemplateContent(template.content))) {
      toast.error(t("Failed to insert the template"));
    }
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

        <div class="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
          <For each={availableDocumentOptions()}>
            {(option) => (
              <button
                type="button"
                class="group flex min-w-0 cursor-pointer items-start gap-4 rounded-lg border border-neutral-200 bg-neutral-10 p-5 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 max-sm:p-4"
                onClick={() => selectType(option.type)}
              >
                <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700 transition-colors group-hover:bg-primary-100">
                  <Icon class="h-6 w-6" name={option.icon} />
                </span>
                <span class="min-w-0 pt-1">
                  <span class="block font-semibold text-[21px] text-neutral-900 leading-7">
                    {t(option.title)}
                  </span>
                  <span class="mt-1 block text-neutral-500 text-size-medium leading-6">
                    {t(option.description)}
                  </span>
                </span>
              </button>
            )}
          </For>
        </div>

        <Show when={templates().length > 0}>
          <div class="mt-8">
            <h2 class="mb-3 font-semibold text-neutral-900 text-size-medium">
              {t("Start from a template")}
            </h2>

            <div class="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              <For each={templates()}>
                {(template) => (
                  <button
                    type="button"
                    class="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 bg-neutral-10 p-3 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                    onClick={() => void selectTemplate(template)}
                  >
                    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700">
                      <Icon class="h-4 w-4" name="document" />
                    </span>
                    <span class="min-w-0">
                      <span class="block truncate font-medium text-neutral-900 text-size-medium">
                        {template.title}
                      </span>
                      <Show when={template.description}>
                        <span class="mt-0.5 line-clamp-2 block text-neutral-500 text-size-small leading-5">
                          {template.description}
                        </span>
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
