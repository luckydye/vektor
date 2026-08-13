export type DocumentPropertyValue = string | string[];
export type DocumentProperties = Record<string, DocumentPropertyValue>;

export type DocumentPropertyPatchValue =
  | null
  | string
  | string[]
  | number
  | boolean
  | Array<string | number | boolean | null>
  | {
      value: unknown;
      type?: string | null;
    };

export type DocumentPropertyPatch = Record<string, DocumentPropertyPatchValue>;

export type DocumentPropertyPatchOperation =
  | { kind: "delete"; key: string }
  | {
      kind: "update";
      key: string;
      value: DocumentPropertyValue;
      type: string | null | undefined;
    };

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
 * These are the three names that corrupt an object on *write*: document
 * properties built as an object literal turn `properties.__proto__ = value`
 * into a prototype reassignment and `properties.constructor = value` /
 * `properties.prototype = value` into a shadowing of members other code reads,
 * so the value either vanishes or changes the object's behaviour instead of
 * being stored.
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

/** Thrown when a property patch has an invalid key or wrapped value shape. */
export class InvalidDocumentPropertyPatchError extends Error {}

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
 * Validate and normalize a complete property patch before persistence starts.
 *
 * Keeping this pure makes the all-or-nothing preflight available to every
 * server transport without coupling the shared property model to HTTP or the
 * database. Reserved keys remain deletable so old poisoned rows can be cleaned
 * up.
 */
export function normalizeDocumentPropertyPatch(
  patch: DocumentPropertyPatch,
): DocumentPropertyPatchOperation[] {
  return Object.entries(patch).map<DocumentPropertyPatchOperation>(
    ([key, patchValue]) => {
      if (!key) {
        throw new InvalidDocumentPropertyPatchError(
          "Property key is required and must be a non-empty string",
        );
      }

      if (patchValue === null) return { kind: "delete", key };
      assertWritableDocumentPropertyKey(key);

      let rawValue: unknown = patchValue;
      let type: string | null | undefined;
      if (typeof patchValue === "object" && !Array.isArray(patchValue)) {
        if (!("value" in patchValue)) {
          throw new InvalidDocumentPropertyPatchError(
            `Property "${key}" object payload must include "value"`,
          );
        }

        rawValue = patchValue.value;
        type = patchValue.type;
        if (type !== undefined && type !== null && typeof type !== "string") {
          throw new InvalidDocumentPropertyPatchError(
            `Property "${key}" type must be a string, null, or undefined`,
          );
        }
      }

      const value = Array.isArray(rawValue)
        ? rawValue
            .filter((item) => item !== null && item !== undefined)
            .map((item) => String(item))
        : String(rawValue);

      return { kind: "update", key, value, type };
    },
  );
}

/**
 * Read one value out of a document's properties.
 *
 * The collection has to stay a plain object — it is the JSON shape of
 * `document.properties` on the wire — so a lookup by a user-supplied key such as
 * `toString` or `constructor` returns an inherited `Object.prototype` member
 * instead of `undefined`. That value is a function, and every check downstream
 * assumes a string or an array, so the lookup either throws
 * (`value.toLowerCase is not a function`) or silently matches. Restricting the
 * lookup to own keys is the only safe way to index properties by a key from a
 * request.
 */
export function readDocumentProperty(
  properties: DocumentProperties,
  key: string,
): DocumentPropertyValue | undefined {
  return Object.hasOwn(properties, key) ? properties[key] : undefined;
}

/**
 * Build a document's properties from its stored rows.
 *
 * Materialised with `Object.fromEntries`, never by assigning into an object
 * literal. Property keys are user-controlled, and
 * `properties["__proto__"] = value` on a literal reassigns the object's
 * prototype instead of storing the value — and because
 * `parseStoredPropertyValue` can return an array, a property named `__proto__`
 * would genuinely replace the object's prototype and type-confuse every later
 * read. `Object.fromEntries` defines own properties, so the key round-trips as
 * ordinary data. Later rows win, as they did before.
 *
 * The result is a normal object, not a null-prototype one, because this is the
 * JSON shape of `document.properties` on the wire and plenty of code treats it as
 * an ordinary object. Indexing it with a key that came from a request must still
 * go through `readDocumentProperty`.
 */
export function toDocumentProperties(
  rows: { key: string; value: string }[],
): DocumentProperties {
  return Object.fromEntries(
    rows.map((row) => [row.key, parseStoredPropertyValue(row.value)]),
  );
}

/** {@link toDocumentProperties} for many documents, keyed by document id. */
export function toDocumentPropertiesByDocument(
  rows: { documentId: string; key: string; value: string }[],
): Map<string, DocumentProperties> {
  const rowsByDocument = new Map<string, { key: string; value: string }[]>();
  for (const row of rows) {
    const existing = rowsByDocument.get(row.documentId);
    if (existing) existing.push(row);
    else rowsByDocument.set(row.documentId, [row]);
  }

  return new Map(
    Array.from(rowsByDocument, ([documentId, documentRows]) => [
      documentId,
      toDocumentProperties(documentRows),
    ]),
  );
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
