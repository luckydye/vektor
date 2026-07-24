<script setup lang="ts">
import { twMerge } from "tailwind-merge";
import { computed, onMounted, ref } from "vue";
import { t } from "#utils/lang.ts";
import Icon from "./Icon.vue";
import type { Property } from "./property.ts";
import type { SelectMenuItem } from "./SelectMenu.vue";
import SelectMenu from "./SelectMenu.vue";
import "@atrium-ui/elements/blur";
import "@atrium-ui/elements/calendar";
import { addIcon } from "~/src/assets/icons.ts";

const inputElement = ref();

const props = defineProps<{
  label?: string;
  nameLabel?: string;
  valueLabels?: string[];
  icon?: string;
  variant?: "default" | "special";
  readonly?: boolean;
  property?: Property | null;
  allowMultiple?: boolean;
  showTooltip?: boolean;
  propertyValues?: (property: Property) => Promise<SelectMenuItem[]>;
}>();

const emit = defineEmits<{
  update: [property: Property & { search: string }];
  delete: [property: Property];
}>();

const valueOptions = ref<SelectMenuItem[]>([]);

const isEditPopoverOpen = ref(false);
const propertyName = ref(props.property?.name || "");
const selectedValue = ref<string | string[] | undefined>(props.property?.value);
const searchInput = ref("");
const dateValue = ref("");

const selectedValues = computed(() => {
  if (Array.isArray(selectedValue.value)) return selectedValue.value;
  return selectedValue.value ? [selectedValue.value] : [];
});

const valueLabels = computed(() => props.valueLabels ?? []);

const handleClick = async () => {
  if (props.readonly || !props.property) return;
  if (props.property) {
    isEditPopoverOpen.value = !isEditPopoverOpen.value;
    propertyName.value = props.property.name;
    selectedValue.value = props.property.value;

    // For date properties, set the date value
    if (
      props.property.type === "date" &&
      props.property.value &&
      !Array.isArray(props.property.value)
    ) {
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
    return [
      {
        id: "__new__",
        label: t("Add {value}").replace("{value}", searchInput.value),
        icon: addIcon,
      },
    ];
  }
  return items;
});

const handleValueSelect = (item: SelectMenuItem) => {
  if (props.property) {
    const itemValue = item.id === "__new__" ? searchInput.value.trim() : item.id;
    if (!itemValue) return;

    if (props.allowMultiple) {
      const nextValue = selectedValues.value.includes(itemValue)
        ? selectedValues.value.filter((value) => value !== itemValue)
        : [...selectedValues.value, itemValue];

      selectedValue.value = nextValue;
      emit("update", {
        ...props.property,
        name: propertyName.value,
        value: nextValue,
        search: searchInput.value,
      });
      searchInput.value = "";
      return;
    }

    selectedValue.value = itemValue;
    emit("update", {
      ...props.property,
      name: propertyName.value,
      value: itemValue,
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
    emit("delete", props.property);
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
    <button
      v-if="property"
      type="button"
      :data-tooltip="showTooltip === false ? undefined : nameLabel || property.name"
      :class="{
        'text-interactive flex items-center gap-4xs py-6xs px-4xs rounded-lg transition-colors': true,
        'bg-primary-50 hover:bg-primary-100 border border-primary-100': variant === 'special',
        'bg-background hover:bg-primary-10 border border-primary-200': variant === 'default',
        'cursor-pointer': property !== null && !readonly,
        'cursor-default': property === null || readonly,
      }"
      @click="handleClick"
    >
      <div
        v-if="icon"
        v-html="icon"
        class="[&_svg]:w-[18px] [&_svg]:h-[18px] [&_svg]:inline"
        :class="variant === 'special' ? '[&_svg]:text-primary-700' : '[&_svg]:text-primary-600'"
      />
      <div
        v-if="!icon"
        class="w-[18px] h-[18px] rounded-sm flex items-center justify-center bg-primary-500"
      />
      <span
        v-if="valueLabels.length === 0"
        :class="twMerge(
            'max-w-[150px] text-ellipsis overflow-hidden whitespace-nowrap capitalize',
            variant === 'special' && 'text-primary-700',
            variant === 'default' && 'text-primary-600'
          )"
      >
        {{ label }}
      </span>
      <span
        v-else
        class="flex items-center gap-4xs min-w-0 max-w-[260px] overflow-hidden"
      >
        <span
          v-for="valueLabel in valueLabels"
          :key="valueLabel"
          class="max-w-[110px] text-ellipsis overflow-hidden whitespace-nowrap capitalize rounded-md bg-primary-50 px-4xs text-primary-600"
        >
          {{ valueLabel }}
        </span>
      </span>
    </button>

    <button
      v-else
      type="button"
      :class="{
        'text-interactive flex items-center gap-4xs py-6xs px-4xs rounded-lg transition-colors': true,
        'bg-primary-50 hover:bg-primary-100 border border-primary-100': variant === 'special',
        'bg-background hover:bg-primary-10 border border-primary-200': variant === 'default',
        'cursor-pointer': property !== null && !readonly,
        'cursor-default': property === null || readonly,
      }"
      @click="handleClick"
    >
      <div
        v-if="icon"
        v-html="icon"
        class="[&_svg]:w-[18px] [&_svg]:h-[18px] [&_svg]:inline"
        :class="variant === 'special' ? '[&_svg]:text-primary-700' : '[&_svg]:text-primary-600'"
      />
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
    <a-blur
      v-if="isEditPopoverOpen && property"
      enabled
      @exit="handleExit"
      class="absolute -top-4xs -left-4xs bg-neutral-10 border border-neutral-100 rounded-lg p-5xs flex flex-col z-50 shadow-large"
    >
      <!-- Property name input with delete button -->
      <div class="flex items-center gap-4xs px-3xs w-full">
        <div
          v-if="icon"
          v-html="icon"
          class="[&_svg]:w-[18px] [&_svg]:h-[18px] [&_svg]:text-neutral-950"
        />
        <div class="flex-1 overflow-hidden py-5xs whitespace-nowrap">
          <input
            v-if="property.type !== 'date'"
            ref="inputElement"
            v-model="searchInput"
            class="bg-transparent border-none outline-none text-interactive w-[150px]"
            :placeholder="nameLabel || property.name || t('Property name')"
          >
          <span v-else class="text-interactive">
            {{ property.name }}
          </span>
        </div>
        <button
          type="button"
          class="shrink-0 transition-opacity hover:opacity-70 cursor-pointer text-neutral-950"
          :aria-label="t('Delete property')"
          @click="handleDelete"
        >
          <Icon name="trash" class="w-[18px] h-[18px]" />
        </button>
      </div>

      <!-- Date Picker for date type -->
      <div v-if="property.type === 'date'">
        <a-calendar :value="dateValue" @change="handleDateChange" class="p-2 w-[250px]" />
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
