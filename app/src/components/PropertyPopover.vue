<script setup lang="ts">
import { ref, watchEffect, computed, onMounted } from "vue";
import "@sv/elements/blur";
import SelectMenu, { type SelectMenuItem } from "./SelectMenu.vue";
import ButtonPrimary from "./ButtonPrimary.vue";
import { plusIcon } from "~/src/assets/icons.ts";

export type PropertyType = "text" | "select" | "date" | "user";

export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  value?: string;
}

export interface SpaceProperty {
  name: string;
  type: string | null;
  values: string[];
}

interface Props {
  property?: Property | null;
  propertyTypes?: SelectMenuItem[];
  propertyValues?: SelectMenuItem[];
  spaceProperties?: SpaceProperty[];
  isOpen?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  property: null,
  propertyTypes: () => [],
  propertyValues: () => [],
  spaceProperties: () => [],
  isOpen: false,
});

const emit = defineEmits<{
  "update:isOpen": [value: boolean];
  create: [property: { name: string; type: string; value?: string }];
  update: [property: Property];
  delete: [propertyId: string];
  close: [];
}>();

type Mode = "select" | "create";

const mode = ref<Mode>("select");
const inputElement = ref();
const propertyName = ref("");
const selectedType = ref("");
const selectedPropertyName = ref("");

const spacePropertyItems = computed<SelectMenuItem[]>(() => {
  return [
    ...props.spaceProperties
      .filter((p) => {
        return !["title"].includes(p.name);
      })
      .map((sp) => ({
        id: sp.name,
        label: sp.name,
        icon: "",
      })),
    { id: "__new__", label: "New Property", icon: plusIcon },
  ];
});

const handleSpacePropertySelect = (item: SelectMenuItem) => {
  if (item.id === "__new__") {
    mode.value = "create";
    propertyName.value = "";
    selectedType.value = "";
  } else {
    selectedPropertyName.value = item.id;
    const spaceProperty = props.spaceProperties.find((sp) => sp.name === item.id);
    if (spaceProperty) {
      emit("create", {
        name: spaceProperty.name,
        type: spaceProperty.type || "text",
      });
    }
  }
};

const handleTypeSelect = (item: SelectMenuItem) => {
  selectedType.value = item.id;
};

const handleCreate = () => {
  if (!propertyName.value.trim() || !selectedType.value) {
    return;
  }

  emit("create", {
    name: propertyName.value.trim(),
    type: selectedType.value,
  });

  propertyName.value = "";
  selectedType.value = "";
  mode.value = "select";
};

const handleBack = () => {
  mode.value = "select";
  propertyName.value = "";
  selectedType.value = "";
};

watchEffect(async () => {
  if (props.isOpen === true) {
    mode.value = "select";
    propertyName.value = "";
    selectedType.value = "";
    selectedPropertyName.value = "";
  }
});

watchEffect(async () => {
  if (props.isOpen === true && mode.value === "create") {
    await new Promise((resolve) => setTimeout(resolve, 25));
    inputElement.value?.focus();
  }
});

const handleExit = () => {
  emit("update:isOpen", false);
};

onMounted(() => {
  window.addEventListener("pointerdown", (e) => {
    if (!e.target?.closest("a-blur") && props.isOpen === true) {
      handleExit();
    }
  });
});
</script>

<template>
  <a-blur v-if="isOpen" enabled @exit="handleExit" class="absolute -top-4xs -left-5xs bg-neutral-10 border border-neutral-100 rounded-lg p-5xs flex flex-col gap-4xs z-50 shadow-large min-w-[200px]">
    <!-- Select Mode: Choose existing property or create new -->
    <template v-if="mode === 'select'">
      <div class="text-xs font-medium text-neutral-600 px-4xs mt-4xs">
        Add Property
      </div>
      <SelectMenu
        :items="spacePropertyItems"
        :model-value="selectedPropertyName"
        @select="handleSpacePropertySelect"
      />
    </template>

    <!-- Create Mode: Property name input and type selection -->
    <template v-else-if="mode === 'create'">
      <div class="flex items-center justify-between px-4xs mt-4xs">
        <div class="text-xs font-medium text-neutral-600">
          New Property
        </div>
        <button @click="handleBack" class="text-xs text-neutral-500 hover:text-neutral-700">
          Back
        </button>
      </div>

      <div class="flex flex-col gap-2.5 px-4xs w-full mt-4xs">
        <div class="flex-1 overflow-hidden">
          <input v-model="propertyName" ref="inputElement" class="bg-transparent border-none outline-none text-interactive w-full px-5xs" placeholder="Property name" />
        </div>
      </div>

      <SelectMenu
        :items="propertyTypes"
        :model-value="selectedType"
        @select="handleTypeSelect"
      />

      <ButtonPrimary
        text="Create"
        class="justify-center"
        :disabled="!propertyName.trim() || !selectedType"
        @click="handleCreate"
      />
    </template>
  </a-blur>
</template>

<style scoped>
button :deep(svg) {
  width: 18px;
  height: 18px;
  color: var(--color-neutral-950);
}
</style>
