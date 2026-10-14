import { createMemo, createSignal, Show } from "solid-js";
import { useTranslation } from "#composeables/useTranslation.ts";
import type { TriggerSpec } from "#documents/properties.ts";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { SelectMenu, type SelectMenuItem } from "./SelectMenu.tsx";

interface Props {
  spec: TriggerSpec | null;
  workflows: SelectMenuItem[];
  /** The date properties of the document a `from` trigger can follow. */
  dateProperties: SelectMenuItem[];
  onSave: (spec: TriggerSpec) => void;
}

/** `datetime-local` reads and writes the wall clock, without a zone. */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function TriggerPropertyEditor(props: Props) {
  const t = useTranslation();

  // solid-reactivity-ok: the editor is a draft seeded once from the stored spec
  const initial = props.spec;
  const [workflow, setWorkflow] = createSignal(initial?.workflow ?? "");
  const [mode, setMode] = createSignal<"at" | "from">(
    initial && "from" in initial ? "from" : "at",
  );
  const [at, setAt] = createSignal(
    initial && "at" in initial ? toLocalInputValue(initial.at) : "",
  );
  const [from, setFrom] = createSignal(initial && "from" in initial ? initial.from : "");
  const [offsetMinutes, setOffsetMinutes] = createSignal(
    initial && "from" in initial ? String(initial.offsetMinutes) : "0",
  );

  const draft = createMemo((): TriggerSpec | null => {
    if (!workflow()) return null;
    if (mode() === "at") {
      return at() ? { workflow: workflow(), at: new Date(at()).toISOString() } : null;
    }
    const offset = Number(offsetMinutes());
    if (!from() || !Number.isFinite(offset)) return null;
    return { workflow: workflow(), from: from(), offsetMinutes: offset };
  });

  const save = () => {
    const spec = draft();
    if (!spec) throw new Error("Trigger is incomplete");
    props.onSave(spec);
  };

  return (
    <div class="flex w-[280px] flex-col gap-3xs p-4xs">
      <span class="px-4xs text-interactive text-neutral-700">{t("Workflow")}</span>
      <Show
        when={props.workflows.length > 0}
        fallback={
          <span class="px-4xs text-interactive text-neutral-500">
            {t("No workflows in this space")}
          </span>
        }
      >
        <SelectMenu
          items={props.workflows}
          value={workflow() || null}
          onSelect={(item) => setWorkflow(item.id)}
        />
      </Show>

      <div class="flex gap-5xs">
        <Button
          size="small"
          variant={mode() === "at" ? "secondary" : "ghost"}
          text={t("At time")}
          onClick={() => setMode("at")}
        />
        <Button
          size="small"
          variant={mode() === "from" ? "secondary" : "ghost"}
          text={t("From date")}
          onClick={() => setMode("from")}
        />
      </div>

      <Show
        when={mode() === "from"}
        fallback={<Input type="datetime-local" value={at()} onInput={setAt} />}
      >
        <Show
          when={props.dateProperties.length > 0}
          fallback={
            <span class="px-4xs text-interactive text-neutral-500">
              {t("No date properties on this document")}
            </span>
          }
        >
          <SelectMenu
            items={props.dateProperties}
            value={from() || null}
            onSelect={(item) => setFrom(item.id)}
          />
        </Show>
        <span class="px-4xs text-interactive text-neutral-700">
          {t("Offset in minutes")}
        </span>
        <Input type="number" value={offsetMinutes()} onInput={setOffsetMinutes} />
      </Show>

      <Button text={t("Save")} disabled={!draft()} onClick={save} />
    </div>
  );
}
