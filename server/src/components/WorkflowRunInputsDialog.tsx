import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { api } from "#api/client.ts";
import { useDocuments } from "#composeables/useDocuments.ts";
import { propertyValueToText } from "#documents/properties.ts";
import type { WorkflowInputField } from "#documents/workflowInputs.ts";
import { Dialog } from "./Dialog.tsx";
import { DialogFooter } from "./DialogFooter.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  fields: WorkflowInputField[];
  spaceId: string;
  documentId: string;
  pending?: boolean;
  error?: string | null;
  onCancel?: () => void;
  onRun?: (inputs: Record<string, string>) => void;
}

export function WorkflowRunInputsDialog(props: Props) {
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [fileNames, setFileNames] = createSignal<Record<string, string>>({});
  const [uploading, setUploading] = createSignal<Record<string, number>>({});
  const [uploadError, setUploadError] = createSignal<string | null>(null);

  const { documents } = useDocuments();

  const documentOptions = createMemo(() =>
    documents()
      .map((doc) => ({
        id: doc.id,
        title: doc.properties?.title
          ? propertyValueToText(doc.properties.title)
          : doc.slug,
      }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  );

  const value = (name: string) => values()[name] ?? "";
  const isUploading = () => Object.keys(uploading()).length > 0;

  const canRun = () =>
    !isUploading() &&
    props.fields.every((field) => !field.required || value(field.name).trim() !== "");

  function setValue(name: string, next: string) {
    setValues((current) => ({ ...current, [name]: next }));
  }

  async function uploadFor(name: string, file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    setUploading((current) => ({ ...current, [name]: 0 }));
    try {
      const { url } = await api.uploads.post(
        props.spaceId,
        file,
        file.name,
        props.documentId,
        {
          onProgress: (progress) =>
            setUploading((current) => ({ ...current, [name]: progress })),
        },
      );
      setValue(name, url);
      setFileNames((current) => ({ ...current, [name]: file.name }));
    } catch (err) {
      setValue(name, "");
      setUploadError(
        err instanceof Error ? err.message : `Failed to upload ${file.name}`,
      );
    } finally {
      setUploading(({ [name]: _dropped, ...rest }) => rest);
    }
  }

  function submit() {
    const inputs: Record<string, string> = {};
    for (const field of props.fields) {
      const entered = value(field.name);
      if (entered !== "") inputs[field.name] = entered;
    }
    const uploadedName = fileNames().file;
    if (inputs.file && uploadedName && !inputs.fileName) inputs.fileName = uploadedName;
    props.onRun?.(inputs);
  }

  return (
    <Dialog
      show={true}
      title="Run workflow"
      onUpdateShow={() => props.onCancel?.()}
      footer={
        <DialogFooter
          layout="end"
          confirmLabel="Run workflow"
          pendingLabel="Starting…"
          pending={props.pending}
          disabled={!canRun()}
          onCancel={() => props.onCancel?.()}
          onConfirm={submit}
        />
      }
    >
      <div class="flex flex-col gap-xs">
        <p class="text-neutral-500 text-size-small">
          This workflow reads the following inputs. Optional ones can stay empty.
        </p>

        <div class="flex flex-col gap-3xs">
          <For each={props.fields}>
            {(field) => (
              <label class="flex flex-col gap-4xs">
                <span class="font-medium text-neutral-700 text-size-small">
                  <span class="font-mono">{field.name}</span>
                  <Show
                    when={field.required}
                    fallback={
                      <span class="ml-1 font-normal text-neutral-400">optional</span>
                    }
                  >
                    <span class="ml-1 text-red-500">*</span>
                  </Show>
                </span>

                <Switch
                  fallback={
                    <input
                      value={value(field.name)}
                      onInput={(event) => setValue(field.name, event.currentTarget.value)}
                      type="text"
                      autocomplete="off"
                      class="rounded-sm border border-neutral-200 bg-background px-2 py-1 text-neutral-700 text-size-small focus:border-primary-400 focus:outline-none"
                    />
                  }
                >
                  <Match when={field.kind === "file"}>
                    <input
                      onChange={(event) =>
                        void uploadFor(field.name, event.currentTarget.files?.[0])
                      }
                      type="file"
                      disabled={uploading()[field.name] !== undefined}
                      class="rounded-sm border border-neutral-200 bg-background px-2 py-1 text-neutral-700 text-size-small file:mr-2 file:rounded-xs file:border-0 file:bg-neutral-100 file:px-2 file:py-1 file:font-medium file:text-neutral-700 file:text-size-small"
                    />
                    <Show when={uploading()[field.name] !== undefined}>
                      <span class="flex items-center gap-1.5 text-neutral-400 text-size-small">
                        <Icon class="h-3 w-3 animate-spin" name="spinner" />
                        Uploading… {Math.round((uploading()[field.name] ?? 0) * 100)}%
                      </span>
                    </Show>
                    <Show
                      when={
                        uploading()[field.name] === undefined && fileNames()[field.name]
                      }
                    >
                      {(name) => (
                        <span class="text-neutral-400 text-size-small">
                          Uploaded {name()}
                        </span>
                      )}
                    </Show>
                  </Match>

                  <Match when={field.kind === "document"}>
                    <select
                      value={value(field.name)}
                      onChange={(event) =>
                        setValue(field.name, event.currentTarget.value)
                      }
                      class="rounded-sm border border-neutral-200 bg-background px-2 py-1 text-neutral-700 text-size-small focus:border-primary-400 focus:outline-none"
                    >
                      <option value="">Select a document…</option>
                      <For each={documentOptions()}>
                        {(option) => <option value={option.id}>{option.title}</option>}
                      </For>
                    </select>
                  </Match>
                </Switch>
              </label>
            )}
          </For>
        </div>

        <Show when={uploadError() ?? props.error}>
          {(message) => <p class="text-red-600 text-size-small">{message()}</p>}
        </Show>
      </div>
    </Dialog>
  );
}
