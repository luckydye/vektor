export type DocumentPropertyValue = string | string[];

export const HIDDEN_DOCUMENT_PROPERTY_KEYS = [
  "title",
  "category",
  "layout",
  "gridtype",
  "parentid",
  "headerimage",
  "headerimageaspect",
];

export function isHiddenDocumentPropertyKey(key: string): boolean {
  return HIDDEN_DOCUMENT_PROPERTY_KEYS.includes(key.toLowerCase()) || key.startsWith("_");
}

export function parseStoredPropertyValue(value: string): DocumentPropertyValue {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
  } catch {
    // Plain string property values are stored as-is.
  }

  return value;
}

export function serializePropertyValue(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((item) => String(item)));
  }

  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

export function propertyValueToText(value: DocumentPropertyValue): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

export function propertyValueToScalar(
  value: DocumentPropertyValue | null | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value === null ? undefined : value;
}

export function optionalPropertyValueToText(
  value: DocumentPropertyValue | null | undefined,
): string | null {
  return value ? propertyValueToText(value) : null;
}

export function propertyValueIncludes(
  value: DocumentPropertyValue | null | undefined,
  expected: string,
): boolean {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.some((item) => item === expected);
}
