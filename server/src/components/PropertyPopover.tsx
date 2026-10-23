import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { twMerge } from "tailwind-merge";
import { Button } from "./Button.tsx";
import { SelectMenu, type SelectMenuItem, useSelectMenuKeys } from "./SelectMenu.tsx";
import { SheetPage } from "./SheetPage.tsx";
import "@atrium-ui/elements/blur";
import { useTranslation } from "#composeables/useTranslation.ts";
import type { Property, SpaceProperty } from "#documents/properties.ts";

interface Props {
  property?: Property | null;
  propertyTypes?: SelectMenuItem[];
  propertyValues?: SelectMenuItem[];
  spaceProperties?: SpaceProperty[];
  isOpen?: boolean;
  /** Opens as a page covering the enclosing sheet, which would clip a popover. */
  sheet?: boolean;
  onUpdateIsOpen?: (value: boolean) => void;
  onCreate?: (property: {
    name: string;
    type: string;
    value?: string | string[];
  }) => void;
  onUpdate?: (property: Property) => void;
  onDelete?: (propertyId: string) => void;
  onClose?: () => void;
}

type Mode = "select" | "create";

export function PropertyPopover(props: Props) {
  const t = useTranslation();

  const [mode, setMode] = createSignal<Mode>("select");
  let inputElement: HTMLInputElement | undefined;
  let searchElement: HTMLInputElement | undefined;
  // The sheet page renders into its Dialog's panel, so it is tracked directly.
  let sheetElement: HTMLDivElement | undefined;
  const [search, setSearch] = createSignal("");
  const [propertyName, setPropertyName] = createSignal("");
  const [selectedType, setSelectedType] = createSignal("");
  const [selectedPropertyName, setSelectedPropertyName] = createSignal("");

  const spacePropertyItems = createMemo<SelectMenuItem[]>(() => [
    ...(props.spaceProperties ?? [])
      .filter(
        (p) =>
          p.name !== "title" &&
          p.name.toLowerCase().includes(search().trim().toLowerCase()),
      )
      .map((sp) => ({
        id: sp.name,
        label: sp.name,
      })),
    { id: "__new__", label: t("New Property"), icon: "add" },
  ]);

  const handleSpacePropertySelect = (item: SelectMenuItem) => {
    if (item.id === "__new__") {
      setMode("create");
      setPropertyName(search().trim());
      setSelectedType("");
      return;
    }
    setSelectedPropertyName(item.id);
    const spaceProperty = (props.spaceProperties ?? []).find((sp) => sp.name === item.id);
    if (spaceProperty) {
      props.onCreate?.({
        name: spaceProperty.name,
        type: spaceProperty.type || "text",
      });
    }
  };

  const searchKeys = useSelectMenuKeys(spacePropertyItems, handleSpacePropertySelect);

  const handleCreate = () => {
    if (!propertyName().trim() || !selectedType()) return;

    props.onCreate?.({
      name: propertyName().trim(),
      type: selectedType(),
    });

    setPropertyName("");
    setSelectedType("");
    setMode("select");
  };

  const handleBack = () => {
    setMode("select");
    setPropertyName("");
    setSelectedType("");
  };

  createEffect(() => {
    if (props.isOpen === true) {
      setMode("select");
      setSearch("");
      setPropertyName("");
      setSelectedType("");
      setSelectedPropertyName("");
    }
  });

  createEffect(() => {
    // On a sheet the keyboard would cover the list; only the name field needs typing.
    if (props.isOpen === true && !(props.sheet && mode() === "select")) {
      const target = mode() === "create" ? inputElement : searchElement;
      const handle = setTimeout(() => target?.focus(), 25);
      onCleanup(() => clearTimeout(handle));
    }
  });

  const handleExit = () => {
    props.onUpdateIsOpen?.(false);
  };

  onMount(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (props.isOpen !== true) return;
      if (props.sheet ? sheetElement?.contains(target) : target?.closest("a-blur"))
        return;
      handleExit();
    };
    window.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => window.removeEventListener("pointerdown", onPointerDown));
  });

  const fieldClass = () =>
    props.sheet
      ? "h-10 w-full flex-none rounded-lg border border-neutral-100 bg-neutral-50 px-3 text-interactive outline-none"
      : "w-full border-none bg-transparent text-interactive outline-none";

  const content = () => (
    <Switch>
      <Match when={mode() === "select"}>
        <input
          ref={searchElement}
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={searchKeys.onKeyDown}
          class={twMerge(fieldClass(), !props.sheet && "mt-4xs px-4xs")}
          placeholder={t("Search properties")}
        />
        <SelectMenu
          uncapped={props.sheet}
          items={spacePropertyItems()}
          value={selectedPropertyName()}
          activeIndex={searchKeys.activeIndex()}
          onSelect={handleSpacePropertySelect}
        />
      </Match>

      <Match when={mode() === "create"}>
        {/* The sheet page's own back button steps back from here. */}
        <Show when={!props.sheet}>
          <div class="mt-4xs flex items-center justify-between px-4xs">
            <div class="font-medium text-neutral-600 text-size-small">
              {t("New Property")}
            </div>
            <button
              type="button"
              onClick={handleBack}
              class="text-neutral-500 text-size-small hover:text-neutral-700"
            >
              {t("Back")}
            </button>
          </div>
        </Show>

        <input
          value={propertyName()}
          onInput={(e) => setPropertyName(e.currentTarget.value)}
          ref={inputElement}
          class={twMerge(fieldClass(), !props.sheet && "mt-4xs px-3xs")}
          placeholder={t("Property name")}
        />

        <SelectMenu
          uncapped={props.sheet}
          items={props.propertyTypes ?? []}
          value={selectedType()}
          onSelect={(item) => setSelectedType(item.id)}
        />

        <Button
          text={t("Create")}
          class="justify-center"
          disabled={!propertyName().trim() || !selectedType()}
          onClick={handleCreate}
        />
      </Match>
    </Switch>
  );

  return (
    <Show when={props.isOpen}>
      <Show
        when={props.sheet}
        fallback={
          <a-blur
            enabled
            on:exit={handleExit}
            class="absolute -top-4xs -left-5xs z-50 flex min-w-[200px] flex-col gap-4xs rounded-lg border border-neutral-100 bg-neutral-10 p-5xs shadow-large"
          >
            {content()}
          </a-blur>
        }
      >
        <SheetPage
          ref={(element) => {
            sheetElement = element;
          }}
          title={t("New property")}
          onBack={() => (mode() === "create" ? handleBack() : handleExit())}
        >
          {content()}
        </SheetPage>
      </Show>
    </Show>
  );
}
