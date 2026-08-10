import { createMemo, createSignal, For, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import { useCategories } from "#composeables/useCategories.ts";
import { useDocument } from "#composeables/useDocument.ts";
import { useMembers } from "#composeables/useMembers.ts";
import { useProperties } from "#composeables/useProperties.ts";
import type { Property } from "#documents/properties.ts";
import {
  isHiddenDocumentPropertyKey,
  propertyValueToScalar,
} from "#documents/properties.ts";
import { getTextColor } from "#utils/color.ts";
import { currentLang, t } from "#utils/lang.ts";
import { Button } from "./Button.tsx";
import type { IconName } from "./Icon.tsx";
import { PropertyChip } from "./PropertyChip.tsx";
import { PropertyPopover } from "./PropertyPopover.tsx";
import type { SelectMenuItem } from "./SelectMenu.tsx";

interface Props {
  documentId?: string;
  documentType?: string;
  layout?: "inline" | "labeled";
  readonly?: boolean;
  initialProperties: Record<string, string | string[] | null | undefined> | undefined;
  initialCategory?: { name: string; slug: string; color?: string; icon?: string } | null;
}

const GRID_TYPE_OPTIONS: SelectMenuItem[] = [
  { id: "grid", label: t("Grid"), icon: "grid-grid" },
  { id: "clean", label: t("Clean"), icon: "grid-clean" },
  { id: "dots", label: t("Dots"), icon: "grid-dots" },
];

const propertyTypes: SelectMenuItem[] = [
  { id: "text", label: t("Text"), icon: "add" },
  { id: "multi-select", label: t("Multi Select"), icon: "add" },
  { id: "date", label: t("Date"), icon: "add" },
  { id: "user", label: t("User"), icon: "people" },
];

export function DocumentProperties(props: Props) {
  const { categories } = useCategories();
  const { document } = useDocument(() => props.documentId);
  const { updateProperty, deleteProperty, properties: spaceProperties } = useProperties();
  const { members } = useMembers();

  const documentProperties = createMemo(
    () => document()?.properties || props.initialProperties || {},
  );

  const effectiveDocumentType = createMemo(
    () => document()?.type || props.documentType || "document",
  );

  const isDocumentType = createMemo(() => effectiveDocumentType() === "document");
  const isCanvasType = createMemo(() => effectiveDocumentType() === "canvas");

  function requireDocumentId(): string {
    if (!props.documentId) {
      throw new Error(t("Cannot update properties before the document exists"));
    }
    return props.documentId;
  }

  const handleUpdateProperty = async (property: Property & { search: string }) => {
    let value = property.value;
    if (property.value === "__new__") value = property.search;

    await updateProperty(requireDocumentId(), property.id, value, property.type);
  };

  const handleDeleteProperty = async (property: Property) => {
    await deleteProperty(requireDocumentId(), property.id);
  };

  const [isCreatePopoverOpen, setIsCreatePopoverOpen] = createSignal(false);

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
    setIsCreatePopoverOpen(false);
  };

  const findCategory = (categorySlug: string) =>
    categories().find((c) => c.slug === categorySlug || c.name === categorySlug) ||
    (props.initialCategory?.slug === categorySlug ||
    props.initialCategory?.name === categorySlug
      ? props.initialCategory
      : null);

  const getCategoryIcon = (categorySlug: string | undefined) => {
    if (!categorySlug) return null;

    const category = findCategory(categorySlug);
    if (!category) return null;

    const bgColor = category.color || "#E5E7EB";
    const textColor = getTextColor(bgColor);
    const iconText = category.icon || category.name.charAt(0).toUpperCase();

    return `<div class="w-[18px] h-[18px] rounded-sm flex items-center justify-center text-size-small font-semibold" style="background-color: ${bgColor}; color: ${textColor};">${iconText}</div>`;
  };

  const getPropertyLabel = (property: Property): string => {
    if (property.name?.toLowerCase() === "category") {
      const categorySlug = propertyValueToScalar(property.value);
      if (!categorySlug) return t("Category");

      const category = findCategory(categorySlug);
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
      const member = members().find((m) => m.userId === value);
      if (member?.user) return member.user.name || member.user.email || value;
      return value;
    }

    if (property.type === "date" && value) {
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

    return property.value.map((value) => getPropertyLabel({ ...property, value }));
  };

  const getPropertyIconSvg = (property: Property) =>
    property.id?.toLowerCase() === "category"
      ? (getCategoryIcon(propertyValueToScalar(property.value)) ?? undefined)
      : undefined;

  const getPropertyIcon = (property: Property): IconName | undefined => {
    if (property.id?.toLowerCase() === "category") return undefined;
    if (property.id?.toLowerCase() === "layout") {
      return propertyValueToScalar(property.value) === "full"
        ? "document-width-full"
        : "document-width-standard";
    }
    if (property.id?.toLowerCase() === "gridtype") {
      return (
        GRID_TYPE_OPTIONS.find((o) => o.id === propertyValueToScalar(property.value))
          ?.icon ?? "grid-dots"
      );
    }
    if (property.type === "user") return "people";
    if (property.type === "date") return "date";
    return "generic-property";
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

  const getPropertyValues = async (property: Property): Promise<SelectMenuItem[]> => {
    if (property.name?.toLowerCase() === "category") {
      return categories().map((cat) => {
        const badge = getCategoryIcon(cat.slug);
        return { id: cat.slug, label: cat.name, iconSvg: badge || undefined };
      });
    }

    if (property.name?.toLowerCase() === "layout") {
      return [
        { id: "document", label: t("Document"), icon: "document-width-standard" },
        { id: "full", label: t("Full Width"), icon: "document-width-full" },
      ];
    }

    if (property.name?.toLowerCase() === "gridtype") {
      return GRID_TYPE_OPTIONS.map((o) => ({ id: o.id, label: o.label, icon: o.icon }));
    }

    if (property.type === "user") {
      return members()
        .filter((member) => member.userId)
        .map((member) => {
          const user = member.user;
          const userName =
            user?.name || user?.email || member.userId || t("Unknown user");
          return {
            id: member.userId as string,
            label: userName,
            icon: "people",
          };
        });
    }

    return (
      spaceProperties()
        ?.find((sp) => sp.name === property.name)
        ?.values?.map((value) => ({
          id: value,
          label: value,
          icon: "generic-property",
        })) || []
    );
  };

  const properties = createMemo((): Property[] => {
    const list: Property[] = [];

    list.push({
      id: "category",
      name: "category",
      type: "select",
      value: propertyValueToScalar(documentProperties().category),
    } as Property);

    if (isDocumentType()) {
      list.push({
        id: "layout",
        name: "layout",
        type: "select",
        value: propertyValueToScalar(documentProperties().layout) || "document",
      } as Property);
    }

    if (isCanvasType()) {
      list.push({
        id: "gridtype",
        name: "gridtype",
        type: "select",
        value: propertyValueToScalar(documentProperties().gridtype) || "dots",
      } as Property);
    }

    const otherProps = Object.entries(documentProperties())
      .map(([key, value]): Property | null => {
        if (isHiddenDocumentPropertyKey(key)) return null;
        const spaceProperty = spaceProperties()?.find((sp) => sp.name === key);
        const propertyType = (spaceProperty?.type as Property["type"]) || "select";

        return {
          id: key,
          name: key,
          type: propertyType,
          value: value === null || value === undefined ? undefined : value,
        } as Property;
      })
      .filter((p): p is Property => p !== null);

    return [...list, ...otherProps];
  });

  const availableNewProperties = createMemo(() =>
    spaceProperties().filter((sp) => {
      if (isHiddenDocumentPropertyKey(sp.name)) return false;
      return !(sp.name in documentProperties());
    }),
  );

  return (
    <div
      class={twMerge(
        "pointer-events-none flex gap-3xs",
        props.layout === "labeled" ? "flex-col items-start" : "flex-wrap items-center",
      )}
    >
      <For each={properties()}>
        {(property) => (
          <div
            class={twMerge(
              "pointer-events-auto",
              props.layout === "labeled" ? "flex min-h-8 items-center gap-3xs" : "",
            )}
          >
            <Show when={props.layout === "labeled"}>
              <span
                class="w-28 shrink-0 truncate text-interactive text-neutral-700"
                title={getPropertyName(property)}
              >
                {getPropertyName(property)}
              </span>
            </Show>

            <PropertyChip
              label={getPropertyLabel(property)}
              nameLabel={getPropertyName(property)}
              valueLabels={getPropertyValueLabels(property)}
              icon={getPropertyIcon(property)}
              iconSvg={getPropertyIconSvg(property)}
              variant={getPropertyVariant(property)}
              readonly={props.readonly}
              property={property}
              showTooltip={props.layout !== "labeled"}
              allowMultiple={
                property.type === "multi-select" || Array.isArray(property.value)
              }
              propertyValues={getPropertyValues}
              onUpdate={
                props.readonly
                  ? undefined
                  : (updated) => void handleUpdateProperty(updated)
              }
              onDelete={
                props.readonly
                  ? undefined
                  : (deleted) => void handleDeleteProperty(deleted)
              }
            />
          </div>
        )}
      </For>

      <Show when={!props.readonly}>
        <div
          class={twMerge(
            "pointer-events-auto",
            props.layout === "labeled" ? "relative ml-28 pl-3xs" : "relative",
          )}
        >
          <Button
            variant="outline"
            size="small"
            icon="add"
            ariaLabel={t("New property")}
            class="w-full justify-center [&_svg]:text-primary-600"
            onClick={() => setIsCreatePopoverOpen(!isCreatePopoverOpen())}
          />

          <PropertyPopover
            isOpen={isCreatePopoverOpen()}
            propertyTypes={propertyTypes}
            spaceProperties={availableNewProperties()}
            onUpdateIsOpen={setIsCreatePopoverOpen}
            onCreate={(property) => void handleCreate(property)}
          />
        </div>
      </Show>
    </div>
  );
}
