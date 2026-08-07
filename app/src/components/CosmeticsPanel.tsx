import { createMemo, createSignal, For, Show } from "solid-js";
import type {
  CosmeticAsset,
  CosmeticLoadout,
  CosmeticSlot,
  PublicUserAppearance,
} from "#cosmetics/types.ts";
import { t } from "#utils/lang.ts";
import "#cosmetics/CosmeticElement.ts";
import "#components/AvatarElement.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  inventory: readonly CosmeticAsset[];
  loadout: Readonly<CosmeticLoadout>;
  appearance: PublicUserAppearance;
  user?: {
    id?: string | null;
    email?: string | null;
    image?: string | null;
    name?: string | null;
  };
  onEquip?: (slot: CosmeticSlot, cosmeticId: string | null) => void;
}

/**
 * Silhouettes for an empty slot, shown in the slot rail and on the "None"
 * tile. Inline rather than in the shared icon set: they exist only to give an
 * unfilled slot a shape, and never appear anywhere else.
 */
const slotGlyphs: Record<CosmeticSlot, string> = {
  avatarFrame: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9" stroke-dasharray="3 3.5"/><circle cx="12" cy="12" r="4.25"/></svg>`,
  cursorCompanion: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M5.5 3.5 19 11.2l-6.2 1.5L9.9 18.5 5.5 3.5Z"/></svg>`,
  caret: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M8.5 5h7M8.5 19h7"/></svg>`,
};

const checkGlyph = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>`;

const pointerGlyph = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.824 2.735a1.1 1.1 0 0 1 1.44 1.44l-6.917 16.5a1.1 1.1 0 0 1-1.015.675h-.902a1.1 1.1 0 0 1-1.028-.706l-2.231-5.816-5.815-2.23a1.1 1.1 0 0 1-.706-1.028v-.902c0-.443.265-.843.674-1.015l16.5-6.918Z"/></svg>`;

const slots = [
  {
    id: "avatarFrame",
    label: t("Avatar frame"),
    description: t("Shown around your avatar across Vektor."),
  },
  {
    id: "cursorCompanion",
    label: t("Cursor companion"),
    description: t("Follows your pointer on shared canvases."),
  },
  {
    id: "caret",
    label: t("Caret"),
    description: t("Replaces your caret while editing."),
  },
] as const satisfies readonly {
  id: CosmeticSlot;
  label: string;
  description: string;
}[];

interface InventoryEntry {
  /** `null` is the "None" entry, which unequips the slot. */
  id: string | null;
  name: string;
  description: string;
  asset: CosmeticAsset | null;
}

export function CosmeticsPanel(props: Props) {
  const [activeSlot, setActiveSlot] = createSignal<CosmeticSlot>(slots[0].id);
  /**
   * Hovering or focusing a tile shows that item on the stage without equipping
   * it, so the whole inventory can be tried on before committing to anything.
   */
  const [preview, setPreview] = createSignal<{
    slot: CosmeticSlot;
    id: string | null;
  } | null>(null);

  const activeDefinition = createMemo(
    () => slots.find((slot) => slot.id === activeSlot()) ?? slots[0],
  );

  const entries = createMemo<InventoryEntry[]>(() => [
    { id: null, name: t("None"), description: t("Nothing equipped."), asset: null },
    ...props.inventory
      .filter((asset) => asset.slot === activeSlot())
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        description: asset.description,
        asset,
      })),
  ]);

  /** Empty slots that pad the shelf out to two full rows. */
  const vacancies = createMemo(() =>
    Array.from({ length: Math.max(0, 6 - entries().length) }, (_, index) => index),
  );

  const equippedIn = (slot: CosmeticSlot): CosmeticAsset | null =>
    props.inventory.find((asset) => asset.id === props.loadout[slot]) ?? null;

  const equippedId = () => props.loadout[activeSlot()] ?? null;

  const stageAppearance = createMemo(() => {
    const pending = preview();
    if (!pending) return props.appearance;
    return { ...props.appearance, [pending.slot]: pending.id ?? undefined };
  });

  const stageUser = createMemo(() => ({
    ...props.user,
    appearance: stageAppearance(),
  }));

  /** What the detail line under the grid describes: the item being tried on,
   *  or the equipped one when nothing is hovered. */
  const detail = createMemo(() => {
    const pending = preview();
    const id = pending?.slot === activeSlot() ? pending.id : equippedId();
    return entries().find((entry) => entry.id === id) ?? entries()[0];
  });

  const equip = (id: string | null) => props.onEquip?.(activeSlot(), id);

  function selectSlot(slot: CosmeticSlot) {
    setPreview(null);
    setActiveSlot(slot);
  }

  return (
    <section class="max-h-[min(70vh,600px)] overflow-y-auto pr-1">
      <div class="mb-3 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="font-semibold text-foreground text-size-medium">{t("Profile")}</h2>
          <p class="mt-0.5 text-neutral-500 text-size-small">
            {t("Personalize how you appear across profiles and live collaboration.")}
          </p>
        </div>
        <a
          href="https://vektorapp.org/shop"
          target="_blank"
          rel="noreferrer"
          class="shrink-0 font-semibold text-primary-600 text-size-small hover:text-primary-700"
        >
          {t("Get more")}
        </a>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-[196px_minmax(0,1fr)]">
        <div class="flex flex-col gap-2">
          {/* The stage: everything equipped, worn at once. */}
          <div class="relative overflow-hidden rounded-xl border border-primary-500/25 bg-neutral-50 px-3 py-4">
            <div
              aria-hidden="true"
              class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,color-mix(in_srgb,var(--color-neutral-400)_45%,transparent)_1px,transparent_0)] opacity-40 [background-size:11px_11px]"
            />
            <div
              aria-hidden="true"
              class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,color-mix(in_srgb,var(--color-primary-500)_16%,transparent),transparent_58%)]"
            />

            <div class="relative flex flex-col items-center">
              <div class="relative flex h-20 w-20 items-center justify-center">
                <span
                  aria-hidden="true"
                  class="absolute inset-1 rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--color-primary-500)_18%,transparent),transparent_72%)] blur-[8px]"
                />
                <vektor-avatar class="relative" size="64" prop:user={stageUser()} />
                {/* Close in on the avatar: the companion trails to the right
                    of the pointer and would otherwise clip the stage edge. */}
                <span class="absolute -right-2 bottom-1 block h-6 w-6 text-primary-600">
                  {/* Mirrored: the glyph is drawn tip-right, and a pointer
                      reads as backwards unless its tip leads to the left. */}
                  <Icon class="h-full w-full -scale-x-100" svg={pointerGlyph} />
                  <vektor-cosmetic
                    class="absolute top-0 left-4 h-8 w-10"
                    attr:asset-id={stageAppearance().cursorCompanion ?? undefined}
                  />
                </span>
              </div>

              <p class="mt-3 max-w-full truncate font-medium text-foreground text-size-small">
                {props.user?.name ?? props.user?.email ?? t("Anonymous User")}
              </p>

              {/* A stand-in line of text, so the caret is shown where a caret
                  actually lives rather than floating on its own. */}
              <span class="mt-2 flex h-6 items-center gap-1.5 rounded-md border border-neutral-200 bg-background px-2">
                <span aria-hidden="true" class="h-1 w-8 rounded-full bg-neutral-300" />
                <span
                  class="relative block h-3.5 w-px"
                  classList={{ "bg-primary-500": !stageAppearance().caret }}
                >
                  <vektor-cosmetic
                    class="absolute bottom-[-3px] -left-1.5 h-6 w-3.5"
                    attr:asset-id={stageAppearance().caret ?? undefined}
                  />
                </span>
                <span aria-hidden="true" class="h-1 w-5 rounded-full bg-neutral-200" />
              </span>
            </div>
          </div>

          {/* The slot rail: what is worn where, and which shelf the inventory
              is showing. */}
          <fieldset class="grid gap-1.5">
            <legend class="sr-only">{t("Slots")}</legend>
            <For each={slots}>
              {(slot) => {
                const active = () => activeSlot() === slot.id;
                const equipped = () => equippedIn(slot.id);
                return (
                  <button
                    type="button"
                    aria-pressed={active()}
                    aria-controls="cosmetics-inventory"
                    onClick={() => selectSlot(slot.id)}
                    class="flex cursor-pointer items-center gap-2.5 rounded-lg border p-1.5 text-left transition-colors"
                    classList={{
                      "border-primary-500 bg-primary-500/10": active(),
                      "border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50":
                        !active(),
                    }}
                  >
                    <span
                      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background"
                      classList={{
                        "border-primary-500/40": active(),
                        "border-neutral-200": !active(),
                        "border-dashed": !equipped(),
                      }}
                    >
                      <Show
                        when={equipped()}
                        fallback={
                          <Icon
                            class="h-4 w-4 text-neutral-400"
                            svg={slotGlyphs[slot.id]}
                          />
                        }
                      >
                        <vektor-cosmetic class="h-6 w-6" attr:asset-id={equipped()?.id} />
                      </Show>
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate font-medium text-foreground text-size-small">
                        {slot.label}
                      </span>
                      <span class="block truncate text-neutral-500 text-size-small">
                        {equipped()?.name ?? t("None")}
                      </span>
                    </span>
                  </button>
                );
              }}
            </For>
          </fieldset>
        </div>

        {/* The inventory: one shelf at a time, for the selected slot. */}
        <div
          id="cosmetics-inventory"
          class="flex flex-col self-start rounded-xl border border-neutral-200 bg-background p-3"
        >
          <div class="flex items-center justify-between gap-2">
            <h3 class="truncate font-semibold text-foreground text-size-small">
              {activeDefinition().label}
            </h3>
            <span class="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-500 text-size-small tabular-nums">
              {entries().length - 1}
            </span>
          </div>
          <p class="mt-0.5 text-neutral-500 text-size-small">
            {activeDefinition().description}
          </p>

          <div
            role="radiogroup"
            aria-label={activeDefinition().label}
            class="mt-3 grid grid-cols-3 gap-2"
            onMouseLeave={() => setPreview(null)}
            onFocusOut={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setPreview(null);
              }
            }}
          >
            <For each={entries()}>
              {(entry) => {
                const checked = () => equippedId() === entry.id;
                return (
                  <label
                    onMouseEnter={() => setPreview({ slot: activeSlot(), id: entry.id })}
                    class="group relative flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border p-1 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-500"
                    classList={{
                      "border-primary-500 bg-primary-500/10": checked(),
                      "border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50":
                        !checked(),
                    }}
                  >
                    {/* A real radio group, so the arrow keys walk the shelf and
                        equip as they go without a keydown handler of our own. */}
                    <input
                      type="radio"
                      class="sr-only"
                      name={`cosmetic-${activeSlot()}`}
                      checked={checked()}
                      onChange={() => equip(entry.id)}
                      onFocus={() => setPreview({ slot: activeSlot(), id: entry.id })}
                    />
                    <span class="flex h-11 w-11 items-center justify-center transition-transform duration-150 group-hover:scale-110">
                      <Show
                        when={entry.asset}
                        fallback={
                          <Icon
                            class="h-5 w-5 text-neutral-400"
                            svg={slotGlyphs[activeSlot()]}
                          />
                        }
                      >
                        <vektor-cosmetic
                          class="h-11 w-11"
                          attr:asset-id={entry.asset?.id}
                        />
                      </Show>
                    </span>
                    <span class="w-full truncate text-center font-medium text-foreground text-size-small">
                      {entry.name}
                    </span>
                    {/* Hidden from the accessibility tree: the radio's checked
                        state already says this, and a second announcement
                        would land in the tile's accessible name. */}
                    <Show when={checked()}>
                      <span
                        aria-hidden="true"
                        title={t("Equipped")}
                        class="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary-600 text-neutral-10"
                      >
                        <Icon class="h-2.5 w-2.5" svg={checkGlyph} />
                      </span>
                    </Show>
                  </label>
                );
              }}
            </For>

            {/* Room to grow, drawn as empty slots rather than as blank space:
                a short shelf otherwise leaves the card looking unfinished. */}
            <For each={vacancies()}>
              {() => (
                <div
                  aria-hidden="true"
                  class="aspect-square rounded-lg border border-neutral-200 border-dashed opacity-70"
                />
              )}
            </For>
          </div>

          <div class="min-h-[52px] pt-3">
            <p class="truncate font-semibold text-foreground text-size-small">
              {detail().name}
            </p>
            <p class="mt-0.5 text-neutral-500 text-size-small">{detail().description}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
