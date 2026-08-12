export type DocumentPropertyValue = string | string[];

export const HIDDEN_DOCUMENT_PROPERTY_KEYS = [
  "title",
  "category",
  "layout",
  "gridtype",
  "parentid",
  "headerimage",
];

export function isHiddenDocumentPropertyKey(key: string): boolean {
  return HIDDEN_DOCUMENT_PROPERTY_KEYS.includes(key.toLowerCase()) || key.startsWith("_");
}

/**
 * Property keys a document may never be given.
 *
 * These are the three names that corrupt an object on *write*: a property bag
 * built as an object literal turns `bag.__proto__ = value` into a prototype
 * reassignment and `bag.constructor = value` / `bag.prototype = value` into a
 * shadowing of members other code reads, so the value either vanishes or
 * changes the object's behaviour instead of being stored.
 *
 * The other `Object.prototype` collisions — `toString`, `valueOf`,
 * `hasOwnProperty` — are deliberately *not* here. They are legitimate property
 * names, and the aggregation that used to choke on them now uses a `Map`
 * (`getAllPropertiesWithValues`), so nothing is left for a denylist to protect.
 * Rejecting them would break real documents for no gain.
 *
 * Matched case-sensitively on purpose: only the exact spellings collide, and
 * `Constructor` is an ordinary name a user is entitled to.
 */
export const RESERVED_DOCUMENT_PROPERTY_KEYS = ["__proto__", "constructor", "prototype"];

export function isReservedDocumentPropertyKey(key: string): boolean {
  return RESERVED_DOCUMENT_PROPERTY_KEYS.includes(key);
}

/**
 * Thrown by the write path when a property key is reserved. Callers at the API
 * boundary turn this into a 400.
 */
export class ReservedDocumentPropertyKeyError extends Error {}

/**
 * Guard every property *write* — not deletes. An already-stored reserved key
 * has to stay deletable, or a document poisoned before this check existed could
 * never be cleaned up through the API.
 */
export function assertWritableDocumentPropertyKey(key: string): void {
  if (isReservedDocumentPropertyKey(key)) {
    throw new ReservedDocumentPropertyKeyError(
      `Property key "${key}" is reserved and cannot be used`,
    );
  }
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

/**
 * Read one property out of a document's property bag.
 *
 * The bag has to stay a plain object — it is the JSON shape of
 * `document.properties` on the wire — so a lookup by a user-supplied key such as
 * `toString` or `constructor` returns an inherited `Object.prototype` member
 * instead of `undefined`. That value is a function, and every check downstream
 * assumes a string or an array, so the lookup either throws
 * (`value.toLowerCase is not a function`) or silently matches. Restricting the
 * lookup to own keys is the only safe way to index a bag by a key from a
 * request.
 */
export function readDocumentProperty(
  properties: Record<string, DocumentPropertyValue>,
  key: string,
): DocumentPropertyValue | undefined {
  return Object.hasOwn(properties, key) ? properties[key] : undefined;
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

// ---------------------------------------------------------------------------
// Property shapes used by the property UI
// ---------------------------------------------------------------------------

export type PropertyType = "text" | "select" | "multi-select" | "date" | "user";

/** A single property on a document, as edited in the property UI. */
export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  value?: DocumentPropertyValue;
}

/** A property key known space-wide, with the values already used for it. */
export interface SpaceProperty {
  name: string;
  type: string | null;
  values: string[];
}

/** A stored property row, reduced to what the space-wide listing reads. */
export interface StoredPropertyRow {
  key: string;
  value: string;
  type: string | null;
}

/**
 * Fold property rows into one entry per key, carrying the distinct values seen.
 *
 * Keyed on a `Map`, and pure and exported so that is testable without a
 * database. Property keys are user-controlled, and on a plain object
 * `byKey["constructor"]` resolves to the inherited `Object` constructor: the
 * truthiness guard below would treat it as an existing entry, skip the
 * initializer, and then call `.values.add` on `Object`. A single document
 * property named `constructor`, `__proto__`, `toString`, `hasOwnProperty` or
 * `valueOf` used to 500 the space-wide property listing — and with it the
 * property panel, the filters and the database-view columns — for every user in
 * the space.
 */
export function aggregateStoredProperties(rows: StoredPropertyRow[]): SpaceProperty[] {
  const byKey = new Map<string, { type: string | null; values: Set<string> }>();

  for (const row of rows) {
    let entry = byKey.get(row.key);
    if (!entry) {
      entry = { type: row.type || null, values: new Set<string>() };
      byKey.set(row.key, entry);
    }

    const parsed = parseStoredPropertyValue(row.value);
    for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!value) continue;
      entry.values.add(value);
    }

    if (row.type && !entry.type) entry.type = row.type;
  }

  return Array.from(byKey, ([name, data]) => ({
    name,
    type: data.type,
    values: Array.from(data.values).sort(),
  }));
}
