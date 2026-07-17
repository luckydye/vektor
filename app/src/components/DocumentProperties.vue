<script setup lang="ts">
import { computed, ref } from "vue";
import { useCategories } from "#composeables/useCategories.ts";
import { useDocument } from "#composeables/useDocument.ts";
import { useMembers } from "#composeables/useMembers.ts";
import { useProperties } from "#composeables/useProperties.ts";
import {
  isHiddenDocumentPropertyKey,
  propertyValueToScalar,
} from "#utils/documentProperties.ts";
import { currentLang, t } from "#utils/lang.ts";
import { getTextColor } from "#utils/utils.ts";
import {
  dateIcon,
  gridCleanIcon,
  gridDotsIcon,
  gridGridIcon,
  documentWidthFullIcon,
  documentWidthStandardIcon,
  peopleIcon,
  addIcon,
  genericPropertyIcon,
} from "~/src/assets/icons.ts";
import type { Property } from "~/src/components/index.ts";
import {
  ButtonIconSmall,
  PropertyChip,
  PropertyPopover,
} from "~/src/components/index.ts";
import { twMerge } from "tailwind-merge";

const props = defineProps<{
  documentId?: string;
  documentType?: string;
  layout?: "inline" | "labeled";
  readonly?: boolean;
  initialProperties: Record<string, string | string[] | null | undefined> | undefined;
  initialCategory?: { name: string; slug: string; color?: string; icon?: string } | null;
}>();

// Backdrop grid options for canvas documents, mirroring the layout picker.
const GRID_TYPE_OPTIONS = [
  { id: "grid", label: t("Grid"), icon: gridGridIcon },
  { id: "clean", label: t("Clean"), icon: gridCleanIcon },
  { id: "dots", label: t("Dots"), icon: gridDotsIcon },
];

const { categories } = useCategories();
const { document } = useDocument(props.documentId);
const { updateProperty, deleteProperty, properties: spaceProperties } = useProperties();
const { members } = useMembers();

const documentProperties = computed(
  () => document.value?.properties || props.initialProperties || {},
);

const effectiveDocumentType = computed(
  () => document.value?.type || props.documentType || "document",
);

const isDocumentType = computed(() => effectiveDocumentType.value === "document");

const isCanvasType = computed(() => effectiveDocumentType.value === "canvas");

function requireDocumentId(): string {
  if (!props.documentId) {
    throw new Error(t("Cannot update properties before the document exists"));
  }
  return props.documentId;
}

const handleUpdateProperty = async (property: Property & { search: string }) => {
  let value = property.value;
  if (property.value === "__new__") {
    value = property.search;
  }

  await updateProperty(requireDocumentId(), property.id, value, property.type);
};

const handleDeleteProperty = async (property: Property) => {
  await deleteProperty(requireDocumentId(), property.id);
};

const isCreatePopoverOpen = ref(false);

const toggleCreatePopover = () => {
  isCreatePopoverOpen.value = !isCreatePopoverOpen.value;
};

const handleCreate = async (property: {
  name: string;
  type: string;
  value?: string | string[];
}) => {
  await updateProperty(
    requireDocumentId(),
    property.name,
    property.type === "multi-select" ? [] : property.value || "",
    property.type,
  );
  isCreatePopoverOpen.value = false;
};

const getCategoryIcon = (categorySlug: string | undefined) => {
  if (!categorySlug) return null;

  const category =
    categories.value.find((c) => c.slug === categorySlug || c.name === categorySlug) ||
    (props.initialCategory?.slug === categorySlug ||
    props.initialCategory?.name === categorySlug
      ? props.initialCategory
      : null);

  if (!category) return null;

  const bgColor = category.color || "#E5E7EB";
  const textColor = getTextColor(bgColor);
  const iconText = category.icon || category.name.charAt(0).toUpperCase();

  return `<div class="w-[18px] h-[18px] rounded-sm flex items-center justify-center text-size-small font-semibold" style="background-color: ${bgColor}; color: ${textColor};">${iconText}</div>`;
};

const getPropertyLabel = (property: Property) => {
  if (property.name?.toLowerCase() === "category") {
    const categorySlug = propertyValueToScalar(property.value);
    if (!categorySlug) return t("Category");

    const category =
      categories.value.find((c) => c.slug === categorySlug || c.name === categorySlug) ||
      (props.initialCategory?.slug === categorySlug ||
      props.initialCategory?.name === categorySlug
        ? props.initialCategory
        : null);

    return category ? category.name : categorySlug;
  }

  if (property.name?.toLowerCase() === "layout") {
    const value = propertyValueToScalar(property.value);
    if (!value) return t("Layout");
    return value === "full" ? t("Full Width") : t("Document");
  }

  if (property.name?.toLowerCase() === "gridtype") {
    const option = GRID_TYPE_OPTIONS.find(
      (o) => o.id === propertyValueToScalar(property.value),
    );
    return option?.label ?? t("Dots");
  }

  const value = propertyValueToScalar(property.value);

  if (property.type === "user" && value) {
    const member = members.value.find((m) => m.userId === value);
    if (member?.user) {
      return member.user.name || member.user.email || value;
    }
    return value;
  }

  if (property.type === "date" && value) {
    // Format date as readable string (e.g., "Jan 15, 2024")
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString(currentLang(), {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
    return value;
  }

  if (Array.isArray(property.value)) {
    return property.value.length > 0 ? property.value.join(", ") : property.name;
  }

  return value || property.name;
};

const getPropertyValueLabels = (property: Property): string[] => {
  if (!Array.isArray(property.value)) return [];

  return property.value.map((value) =>
    getPropertyLabel({
      ...property,
      value,
    }),
  );
};

const getPropertyIcon = (property: Property) => {
  if (property.id?.toLowerCase() === "category") {
    return getCategoryIcon(propertyValueToScalar(property.value)) || undefined;
  }
  if (property.id?.toLowerCase() === "layout") {
    return propertyValueToScalar(property.value) === "full"
      ? documentWidthFullIcon
      : documentWidthStandardIcon;
  }
  if (property.id?.toLowerCase() === "gridtype") {
    return (
      GRID_TYPE_OPTIONS.find((o) => o.id === propertyValueToScalar(property.value))
        ?.icon ?? gridDotsIcon
    );
  }
  if (property.type === "user") {
    return peopleIcon;
  }
  if (property.type === "date") {
    return dateIcon;
  }
  return genericPropertyIcon;
};

const getPropertyVariant = (property: Property): "default" | "special" => {
  const propertyName = property.name?.toLowerCase();
  return propertyName === "category" ||
    propertyName === "layout" ||
    propertyName === "gridtype"
    ? "special"
    : "default";
};

const getPropertyName = (property: Property): string => {
  const normalizedName = property.name.toLowerCase();
  if (normalizedName === "category") return t("Category");
  if (normalizedName === "layout") return t("Layout");
  if (normalizedName === "gridtype") return t("Grid");

  return property.name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
};

const getPropertyValues = async (property: Property) => {
  if (property.name?.toLowerCase() === "category") {
    return categories.value.map((cat) => {
      const icon = getCategoryIcon(cat.slug);
      return { id: cat.slug, label: cat.name, icon: icon || undefined };
    });
  }

  if (property.name?.toLowerCase() === "layout") {
    return [
      { id: "document", label: t("Document"), icon: documentWidthStandardIcon },
      { id: "full", label: t("Full Width"), icon: documentWidthFullIcon },
    ];
  }

  if (property.name?.toLowerCase() === "gridtype") {
    return GRID_TYPE_OPTIONS.map((o) => ({ id: o.id, label: o.label, icon: o.icon }));
  }

  if (property.type === "user") {
    return members.value
      .filter((member) => member.userId)
      .map((member) => {
        const user = member.user;
        const userName = user?.name || user?.email || member.userId || t("Unknown user");
        return {
          id: member.userId!,
          label: userName,
          icon: peopleIcon,
        };
      });
  }

  const propertyValues =
    spaceProperties.value
      ?.find((sp) => sp.name === property.name)
      ?.values?.map((value) => {
        return { id: value, label: value, icon: genericPropertyIcon };
      }) || [];

  return propertyValues;
};

const properties = computed((): Property[] => {
  const props_list: Property[] = [];

  props_list.push({
    id: "category",
    name: "category",
    type: "select",
    value: propertyValueToScalar(documentProperties.value.category),
  } as Property);

  if (isDocumentType.value) {
    props_list.push({
      id: "layout",
      name: "layout",
      type: "select",
      value: propertyValueToScalar(documentProperties.value.layout) || "document",
    } as Property);
  }

  if (isCanvasType.value) {
    props_list.push({
      id: "gridtype",
      name: "gridtype",
      type: "select",
      value: propertyValueToScalar(documentProperties.value.gridtype) || "dots",
    } as Property);
  }

  const otherProps = Object.entries(documentProperties.value)
    .map(([key, value]): Property | null => {
      if (isHiddenDocumentPropertyKey(key)) {
        return null;
      }
      const spaceProperty = spaceProperties.value?.find((sp) => sp.name === key);
      const propertyType = (spaceProperty?.type as Property["type"]) || "select";

      return {
        id: key,
        name: key,
        type: propertyType,
        value: value === null || value === undefined ? undefined : value,
      } as Property;
    })
    .filter((p): p is Property => p !== null);

  return [...props_list, ...otherProps] as Property[];
});

const propertyTypes = [
  { id: "text", label: t("Text"), icon: addIcon },
  { id: "multi-select", label: t("Multi Select"), icon: addIcon },
  { id: "date", label: t("Date"), icon: addIcon },
  { id: "user", label: t("User"), icon: peopleIcon },
];

const availableNewProperties = computed(() => {
  return (
    spaceProperties.value.filter((sp) => {
      if (isHiddenDocumentPropertyKey(sp.name)) return false;
      return !(sp.name in documentProperties.value);
    }) || []
  );
});
</script>

<template>
  <div
    :class="
      twMerge('flex gap-3xs pointer-events-none', layout === 'labeled'
        ? 'flex-col items-start'
        : 'flex-wrap items-center')
    "
  >
    <div
      v-for="property in properties"
      :key="property.id"
      :class="twMerge('pointer-events-auto', layout === 'labeled' ? 'flex min-h-8 items-center gap-3xs' : '')"
    >
      <span
        v-if="layout === 'labeled'"
        class="w-28 shrink-0 truncate text-interactive text-neutral-700"
        :title="getPropertyName(property)"
      >
        {{ getPropertyName(property) }}
      </span>

      <PropertyChip
        :label="getPropertyLabel(property)"
        :name-label="getPropertyName(property)"
        :value-labels="getPropertyValueLabels(property)"
        :icon="getPropertyIcon(property)"
        :variant="getPropertyVariant(property)"
        :readonly="readonly"
        :property="property as any"
        :show-tooltip="layout !== 'labeled'"
        :allow-multiple="property.type === 'multi-select' || Array.isArray(property.value)"
        :property-values="getPropertyValues"
        v-bind="readonly ? {} : { onUpdate: handleUpdateProperty, onDelete: handleDeleteProperty }"
      />
    </div>

    <div
      v-if="!readonly"
      :class="twMerge('pointer-events-auto', layout === 'labeled' ? 'relative ml-28 pl-3xs' : 'relative')"
    >
      <ButtonIconSmall
        :icon="addIcon"
        :aria-label="t('New property')"
        @click="toggleCreatePopover"
      />

      <PropertyPopover
        :is-open="isCreatePopoverOpen"
        :property-types="propertyTypes"
        :space-properties="availableNewProperties"
        @update:is-open="(val) => (isCreatePopoverOpen = val)"
        @create="handleCreate"
      />
    </div>
  </div>
</template>

<style scoped>
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
button :deep(svg) {
  color: var(--color-primary-600);
  display: inline;
}
</style>
