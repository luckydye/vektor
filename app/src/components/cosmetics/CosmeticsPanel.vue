<script setup lang="ts">
import { computed } from "vue";
import type {
  CosmeticAsset,
  CosmeticLoadout,
  CosmeticSlot,
  PublicUserAppearance,
} from "#cosmetics/types.ts";
import { t } from "#utils/lang.ts";
import "#cosmetics/CosmeticElement.ts";
import "../AvatarElement.ts";

const props = defineProps<{
  inventory: readonly CosmeticAsset[];
  loadout: Readonly<CosmeticLoadout>;
  appearance: PublicUserAppearance;
  user?: {
    id?: string | null;
    email?: string | null;
    image?: string | null;
    name?: string | null;
  };
}>();

const emit = defineEmits<{
  equip: [slot: CosmeticSlot, cosmeticId: string | null];
}>();

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
    id: "caretDecoration",
    label: t("Caret decoration"),
    description: t("Appears beside your caret while editing."),
  },
] as const satisfies readonly {
  id: CosmeticSlot;
  label: string;
  description: string;
}[];

const assetsBySlot = computed(() => {
  const result = new Map<CosmeticSlot, CosmeticAsset[]>();
  for (const slot of slots) {
    result.set(
      slot.id,
      props.inventory.filter((asset) => asset.slot === slot.id),
    );
  }
  return result;
});

const previewUser = computed(() => ({
  ...props.user,
  appearance: props.appearance,
}));
</script>

<template>
  <section class="max-h-[min(72vh,720px)] overflow-y-auto pr-1">
    <div class="mb-4">
      <h2 class="text-size-medium font-semibold text-foreground">{{ t("Cosmetics") }}</h2>
      <p class="mt-1 text-size-small text-neutral-500">
        {{ t("Personalize how you appear across profiles and live collaboration.") }}
      </p>
    </div>

    <div
      class="relative mb-5 overflow-hidden rounded-xl border border-primary-500/20 bg-neutral-50 p-4"
    >
      <div class="flex items-center gap-5">
        <div class="flex h-20 w-20 items-center justify-center">
          <vektor-avatar size="large" :user="previewUser" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-size-small font-semibold text-foreground">
            {{ t("Live preview") }}
          </p>
          <p class="mt-1 text-label text-neutral-500">
            {{ t("Your selected frame, pointer companion, and caret decoration.") }}
          </p>
          <div class="mt-3 flex h-10 items-center gap-8">
            <span class="relative block h-7 w-7 text-primary-600">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M19.824 2.735a1.1 1.1 0 0 1 1.44 1.44l-6.917 16.5a1.1 1.1 0 0 1-1.015.675h-.902a1.1 1.1 0 0 1-1.028-.706l-2.231-5.816-5.815-2.23a1.1 1.1 0 0 1-.706-1.028v-.902c0-.443.265-.843.674-1.015l16.5-6.918Z"/>
              </svg>
              <vektor-cosmetic
                class="absolute left-5 top-0 h-9 w-11"
                :asset-id="appearance.cursorCompanion"
              />
            </span>
            <span class="relative block h-8 border-l-2 border-primary-500">
              <vektor-cosmetic
                class="absolute bottom-0 left-1 h-8 w-8"
                :asset-id="appearance.caretDecoration"
              />
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="space-y-6">
      <section v-for="slot in slots" :key="slot.id">
        <div>
          <h3 class="text-size-small font-semibold text-foreground">{{ slot.label }}</h3>
          <p class="mt-0.5 text-label text-neutral-500">{{ slot.description }}</p>
        </div>

        <div class="mt-3 grid grid-cols-3 gap-3">
          <button
            type="button"
            class="group rounded-lg border p-2 text-left transition-colors"
            :class="
              !loadout[slot.id]
                ? 'border-primary-500 bg-primary-500/5'
                : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50'
            "
            :aria-pressed="!loadout[slot.id]"
            @click="emit('equip', slot.id, null)"
          >
            <span
              class="flex h-14 items-center justify-center rounded-md bg-neutral-100 text-size-small font-medium text-neutral-400"
            >
              {{ t("None") }}
            </span>
            <span class="mt-2 block text-label font-medium text-foreground">
              {{ t("None") }}
            </span>
          </button>

          <button
            v-for="asset in assetsBySlot.get(slot.id)"
            :key="asset.id"
            type="button"
            class="group rounded-lg border p-2 text-left transition-colors"
            :class="
              loadout[slot.id] === asset.id
                ? 'border-primary-500 bg-primary-500/5'
                : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50'
            "
            :aria-pressed="loadout[slot.id] === asset.id"
            :title="asset.description"
            @click="emit('equip', slot.id, asset.id)"
          >
            <span
              class="flex h-14 items-center justify-center rounded-md bg-neutral-100"
            >
              <vektor-cosmetic class="h-12 w-12" :asset-id="asset.id" />
            </span>
            <span class="mt-2 block truncate text-label font-medium text-foreground">
              {{ asset.name }}
            </span>
          </button>
        </div>
      </section>
    </div>

    <div
      class="mt-6 flex items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-3"
    >
      <p class="text-label leading-5 text-neutral-500">
        {{ t("Selections are stored on this device until Vektor Cloud is connected.") }}
      </p>
      <a
        href="https://vektorapp.org/cosmetics"
        target="_blank"
        rel="noreferrer"
        class="shrink-0 text-size-small font-semibold text-primary-600 hover:text-primary-700"
      >
        {{ t("Get more") }}
      </a>
    </div>
  </section>
</template>
