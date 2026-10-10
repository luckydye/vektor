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
import { Button } from "./Button.tsx";
import { SelectMenu, type SelectMenuItem, useSelectMenuKeys } from "./SelectMenu.tsx";
import "@atrium-ui/elements/blur";
import type { Property, SpaceProperty } from "#documents/properties.ts";
import { useTranslation } from "#composeables/useTranslation.ts";

interface Props {
  property?: Property | null;
  propertyTypes?: SelectMenuItem[];
  propertyValues?: SelectMenuItem[];
  spaceProperties?: SpaceProperty[];
  isOpen?: boolean;
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
  const [search, setSearch] = createSignal("");
  const [propertyName, setPropertyName] = createSignal("");
  const [selectedType, setSelectedType] = createSignal("");
  const [selectedPropertyName, setSelectedPropertyName] = createSignal("");

  const spacePropertyItems = createMemo<SelectMenuItem[]>(() => [
    ...(props.spaceProperties ?? [])
      .filter(
        (p) =>
          p.name !== "title" && p.name.toLowerCase().includes(search().trim().toLowerCase()),
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
    if (props.isOpen === true) {
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
      if (!(e.target as Element | null)?.closest("a-blur") && props.isOpen === true) {
        handleExit();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => window.removeEventListener("pointerdown", onPointerDown));
  });

  return (
    <Show when={props.isOpen}>
      <a-blur
        enabled
        on:exit={handleExit}
        class="absolute -top-4xs -left-5xs z-50 flex min-w-[200px] flex-col gap-4xs rounded-lg border border-neutral-100 bg-neutral-10 p-5xs shadow-large"
      >
        <Switch>
          <Match when={mode() === "select"}>
            <input
              ref={searchElement}
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={searchKeys.onKeyDown}
              class="mt-4xs w-full border-none bg-transparent px-4xs text-interactive outline-none"
              placeholder={t("Search properties")}
            />
            <SelectMenu
              items={spacePropertyItems()}
              value={selectedPropertyName()}
              activeIndex={searchKeys.activeIndex()}
              onSelect={handleSpacePropertySelect}
            />
          </Match>

          <Match when={mode() === "create"}>
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

            <div class="mt-4xs flex w-full flex-col gap-2.5 px-4xs">
              <div class="flex-1 overflow-hidden">
                <input
                  value={propertyName()}
                  onInput={(e) => setPropertyName(e.currentTarget.value)}
                  ref={inputElement}
                  class="w-full border-none bg-transparent px-5xs text-interactive outline-none"
                  placeholder={t("Property name")}
                />
              </div>
            </div>

            <SelectMenu
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
      </a-blur>
    </Show>
  );
}
