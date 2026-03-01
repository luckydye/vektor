<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { Property } from "./PropertyPopover.vue";
import type { SelectMenuItem } from "./SelectMenu.vue";
import SelectMenu from "./SelectMenu.vue";
import Tooltip from "./Tooltip.vue";
import "@sv/elements/blur";
import "@sv/elements/calendar";
import { plusIcon } from "~/src/assets/icons.ts";
import Icon from "./Icon.vue";
import { twMerge } from "tailwind-merge";

const inputElement = ref();

const props = defineProps<{
  label?: string;
  icon?: string;
  variant?: "default" | "special";
  property?: Property | null;
  propertyValues?: (property: Property) => Promise<SelectMenuItem[]>;
}>();

const emit = defineEmits<{
  update: [property: Property & { search: string }];
  delete: [propertyId: string];
}>();

const valueOptions = ref<SelectMenuItem[]>([]);

const isEditPopoverOpen = ref(false);
const propertyName = ref(props.property?.name || "");
const selectedValue = ref(props.property?.value);
const searchInput = ref("");
const dateValue = ref("");

const handleClick = async () => {
  if (props.property) {
    isEditPopoverOpen.value = !isEditPopoverOpen.value;
    propertyName.value = props.property.name;
    selectedValue.value = props.property.value;

    // For date properties, set the date value
    if (props.property.type === "date" && props.property.value) {
      dateValue.value = props.property.value;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));

    // Only fetch options for non-date properties
    if (props.property.type !== "date") {
      inputElement.value?.focus();

      props.propertyValues?.(props.property).then((options) => {
        valueOptions.value = options;
      });
    }
  }
};

const filteredValueOptions = computed(() => {
  const searchTerm = searchInput.value.toLowerCase();
  const items = valueOptions.value.filter((item) =>
    item.label?.toLowerCase().includes(searchTerm),
  );
  if (items.length === 0) {
    return [{ id: "__new__", label: `Add ${searchInput.value}`, icon: plusIcon }];
  }
  return items;
});

const handleValueSelect = (item: SelectMenuItem) => {
  if (props.property) {
    selectedValue.value = item.id;
    emit("update", {
      ...props.property,
      name: propertyName.value,
      value: item.id,
      search: searchInput.value,
    });
    handleExit();
  }
};

const handleDateChange = (event: Event) => {
  const target = event.target as HTMLInputElement;
  if (props.property) {
    emit("update", {
      ...props.property,
      name: propertyName.value,
      value: target.value,
      search: "",
    });
    handleExit();
  }
};

const handleDelete = () => {
  if (props.property) {
    emit("delete", props.property.id);
    handleExit();
  }
};

const handleExit = () => {
  isEditPopoverOpen.value = false;
  searchInput.value = "";
  dateValue.value = "";
};

onMounted(() => {
  window.addEventListener("pointerdown", (e) => {
    if (!e.target?.closest("a-blur") && isEditPopoverOpen.value === true) {
      handleExit();
    }
  });
});
</script>

<template>
  <div class="relative">
    <Tooltip v-if="property" :text="property.name" position="top">
      <button
        type="button"
        :class="{
          'text-interactive flex items-center gap-4xs px-3xs rounded-lg transition-colors': true,
          'bg-primary-50 hover:bg-primary-100 border-0': variant === 'special',
          'bg-background hover:bg-primary-10 border border-primary-200': variant === 'default',
          'py-1': true,
          'cursor-pointer': property !== null,
          'cursor-default': property === null,
        }"
        @click="handleClick"
      >
        <div v-if="icon" v-html="icon" />
        <div v-if="!icon" class="w-[18px] h-[18px] rounded flex items-center justify-center bg-primary-500" />
        <span
            :class="twMerge(
              'max-w-[150px] text-ellipsis overflow-hidden whitespace-nowrap capitalize',
              variant === 'special' && 'text-primary-700',
              variant === 'default' && 'text-primary-600'
            )"
        >
          {{ label }}
        </span>
      </button>
    </Tooltip>

    <button
      v-else
      type="button"
      :class="{
        'text-interactive flex items-center gap-4xs px-3xs rounded-lg transition-colors': true,
        'bg-primary-50 hover:bg-primary-100 border-0': variant === 'special',
        'bg-background hover:bg-primary-10 border border-primary-200': variant === 'default',
        'py-1': true,
        'cursor-pointer': property !== null,
        'cursor-default': property === null,
      }"
      @click="handleClick"
    >
      <div v-if="icon" v-html="icon" />
      <span
        :class="{
          'text-primary-700': variant === 'special',
          'text-primary-600': variant === 'default',
        }"
      >
        {{ label }}
      </span>
    </button>

    <!-- Edit Property Popover -->
    <a-blur v-if="isEditPopoverOpen && property" enabled @exit="handleExit" class="absolute -top-4xs -left-4xs bg-neutral-10 border border-neutral-100 rounded-lg p-5xs flex flex-col z-50 shadow-large">
      <!-- Property name input with delete button -->
      <div class="flex items-center gap-4xs px-4xs w-full">
        <div v-if="icon" v-html="icon" />
        <div class="flex-1 overflow-hidden py-5xs whitespace-nowrap">
          <input
            v-if="property.type !== 'date'"
            ref="inputElement"
            v-model="searchInput"
            class="bg-transparent border-none outline-none text-interactive w-[150px]"
            :placeholder="property.name || 'Property name'"
          />
          <span
            v-else
            class="text-interactive"
          >
            {{ property.name }}
          </span>
        </div>
        <button
          type="button"
          class="shrink-0 transition-opacity hover:opacity-70 cursor-pointer"
          @click="handleDelete"
        >
          <Icon name="trash" />
        </button>
      </div>

      <!-- Date Picker for date type -->
      <div v-if="property.type === 'date'">
        <a-calendar
          :value="dateValue"
          @change="handleDateChange"
          class="p-2 w-[250px]"
        />
      </div>

      <!-- Property Value Selector for other types -->
      <SelectMenu
        v-else
        :items="filteredValueOptions"
        :model-value="selectedValue"
        @select="handleValueSelect"
      />
    </a-blur>
  </div>
</template>

<style scoped>
button :deep(svg) {
  width: 18px;
  height: 18px;
  display: inline;
}

button.bg-primary-50 :deep(svg) {
  color: var(--color-primary-700);
}

button.bg-background :deep(svg) {
  color: var(--color-primary-600);
}

a-blur :deep(svg) {
  width: 18px;
  height: 18px;
  color: var(--color-neutral-950);
}

a-calendar {
    --calendar-hover-bg: rgba(250, 250, 250, 0.1);
    --calendar-selected-bg: var(--color-primary-500);
    --calendar-selected-color: white;
    --calendar-range-bg: var(--color-primary-300);
    --calendar-highlight-bg: rgba(234, 179, 8, 0.4);
    --calendar-focus-outline: currentColor;
}
</style>
