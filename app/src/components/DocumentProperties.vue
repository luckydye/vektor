<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ButtonIconSmall,
  PropertyChip,
  PropertyPopover,
  type Property,
} from "~/src/components/index.ts";
import {
  plusIcon,
  peopleIcon,
  calendarIcon,
  propertyIcon,
  layoutFullIcon,
  layoutDocumentIcon,
} from "~/src/assets/icons.ts";

import { useCategories } from "../composeables/useCategories.ts";
import { getTextColor } from "../utils/utils.ts";
import { useProperties } from "../composeables/useProperties.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useMembers } from "../composeables/useMembers.ts";

const props = defineProps<{
  documentId?: string;
  documentType?: string;
  initialProperties: Record<string, string | null | undefined> | undefined;
}>();

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

function requireDocumentId(): string {
  if (!props.documentId) {
    throw new Error("Cannot update properties before the document exists");
  }
  return props.documentId;
}

const handleUpdateProperty = async (property: Property & { search: string }) => {
  let value = property.value;
  if (property.value === "__new__") {
    value = property.search;
  }

  await updateProperty(requireDocumentId(), property.id, value);
};

const handleDeleteProperty = (propertyId: string) => {
  deleteProperty(requireDocumentId(), propertyId);
};

const isCreatePopoverOpen = ref(false);

const toggleCreatePopover = () => {
  isCreatePopoverOpen.value = !isCreatePopoverOpen.value;
};

const handleCreate = async (property: { name: string; type: string; value?: string }) => {
  await updateProperty(
    requireDocumentId(),
    property.name,
    property.value || "",
    property.type,
  );
  isCreatePopoverOpen.value = false;
};

const getCategoryIcon = (categorySlug: string | undefined) => {
  if (!categorySlug) return null;

  const category = categories.value.find(
    (c) => c.slug === categorySlug || c.name === categorySlug,
  );

  if (!category) return null;

  const bgColor = category.color || "#E5E7EB";
  const textColor = getTextColor(bgColor);
  const iconText = category.icon || category.name.charAt(0).toUpperCase();

  return `<div class="w-[18px] h-[18px] rounded flex items-center justify-center text-xs font-semibold" style="background-color: ${bgColor}; color: ${textColor};">${iconText}</div>`;
};

const getPropertyLabel = (property: Property) => {
  if (property.name?.toLowerCase() === "category") {
    const categorySlug = property.value;
    if (!categorySlug) return "Category";

    const category = categories.value.find(
      (c) => c.slug === categorySlug || c.name === categorySlug,
    );

    return category ? category.name : categorySlug;
  }

  if (property.name?.toLowerCase() === "layout") {
    if (!property.value) return "Layout";
    return property.value === "full" ? "Full Width" : "Document";
  }

  if (property.type === "user" && property.value) {
    const member = members.value.find((m) => m.userId === property.value);
    if (member?.user) {
      return member.user.name || member.user.email || property.value;
    }
    return property.value;
  }

  if (property.type === "date" && property.value) {
    // Format date as readable string (e.g., "Jan 15, 2024")
    const date = new Date(property.value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
    return property.value;
  }

  return property.value || property.name;
};

const getPropertyIcon = (property: Property) => {
  if (property.id?.toLowerCase() === "category") {
    return getCategoryIcon(property.value) || undefined;
  }
  if (property.id?.toLowerCase() === "layout") {
    return property.value === "full" ? layoutFullIcon : layoutDocumentIcon;
  }
  if (property.type === "user") {
    return peopleIcon;
  }
  if (property.type === "date") {
    return calendarIcon;
  }
  return propertyIcon;
};

const getPropertyVariant = (property: Property): "default" | "special" => {
  const propertyName = property.name?.toLowerCase();
  return propertyName === "category" || propertyName === "layout" ? "special" : "default";
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
      { id: "document", label: "Document", icon: layoutDocumentIcon },
      { id: "full", label: "Full Width", icon: layoutFullIcon },
    ];
  }

  if (property.type === "user") {
    return members.value
      .filter((member) => member.userId)
      .map((member) => {
        const user = member.user;
        const userName = user?.name || user?.email || member.userId || "Unknown User";
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
        return { id: value, label: value, icon: propertyIcon };
      }) || [];

  return propertyValues;
};

const properties = computed((): Property[] => {
  const props_list: Property[] = [];

  props_list.push({
    id: "category",
    name: "category",
    type: "select",
    value: documentProperties.value.category,
  } as Property);

  if (isDocumentType.value) {
    props_list.push({
      id: "layout",
      name: "layout",
      type: "select",
      value: documentProperties.value.layout || "document",
    } as Property);
  }

  const otherProps = Object.entries(documentProperties.value)
    .map(([key, value]): Property | null => {
      if (["title", "category", "layout", "parentid"].includes(key?.toLowerCase())) {
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
  { id: "text", label: "Text", icon: plusIcon },
  { id: "date", label: "Date", icon: plusIcon },
  { id: "user", label: "User", icon: peopleIcon },
];

const availableNewProperties = computed(() => {
  return (
    spaceProperties.value.filter((sp) => {
      return !(sp.name in documentProperties.value);
    }) || []
  );
});
</script>

<template>
  <div class="flex items-center gap-3">
    <div class="flex flex-wrap items-center gap-3xs">
      <PropertyChip
        v-for="(property) in properties"
        :key="property.id"
        :label="getPropertyLabel(property)"
        :icon="getPropertyIcon(property)"
        :variant="getPropertyVariant(property)"
        :property="property as any"
        :property-values="getPropertyValues"
        @update="handleUpdateProperty"
        @delete="handleDeleteProperty"
      />

      <div class="relative">
        <ButtonIconSmall :icon="plusIcon" aria-label="New property" @click="toggleCreatePopover" />

        <PropertyPopover
          :is-open="isCreatePopoverOpen"
          :property-types="propertyTypes"
          :space-properties="availableNewProperties"
          @update:is-open="(val) => (isCreatePopoverOpen = val)"
          @create="handleCreate"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
button :deep(svg) {
  color: var(--color-primary-600);
  display: inline;
}
</style>
