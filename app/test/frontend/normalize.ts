/**
 * Turns rendered DOM into something two frameworks can be compared on.
 *
 * A raw `innerHTML` snapshot is 100% noise across a framework change: Vue emits
 * `data-v-*` scope attributes and its own comment anchors, Solid emits `data-hk`
 * hydration keys and `<!--$-->` markers, and the two compilers order class
 * tokens differently for identical input. None of that is behaviour. What is
 * left after stripping it — element structure, roles, text, meaningful
 * attributes — is the thing that must not change at the cutover.
 *
 * Everything here removes or canonicalises. Nothing invents: if a real
 * attribute disappears between Vue and Solid, the diff must show it.
 */

/** Attributes that exist only to serve a framework's renderer. */
const FRAMEWORK_ATTRIBUTES = [
  /^data-v-/i, // Vue scope ids (`data-v-1a2b3c`) and its mount marker (`data-v-app`)
  /^data-hk$/, // Solid hydration key
  /^data-astro-source-(file|loc)$/, // Astro dev-only source mapping
  /^data-astro-cid-[\w-]+$/i,
];

/** Attribute values that are generated per render and cannot be compared. */
const VOLATILE_ATTRIBUTES = new Set([
  "id",
  "for",
  "aria-controls",
  "aria-labelledby",
  "aria-describedby",
  "aria-owns",
  "aria-activedescendant",
  "popovertarget",
  "form",
]);

/**
 * Ids that are stable *by design* — a hand-written hook the app or a spec
 * targets. Replacing these would hide a real regression, so they survive.
 */
const STABLE_IDS = new Set([
  "toast-container",
  "root",
  "env",
  "document-properties",
  "document-footer",
  "document-actions",
]);

const RELATIVE_TIME =
  /\b(?:just now|now|yesterday|today|(?:in )?\d+\s+(?:second|minute|hour|day|week|month|year)s?(?:\s+ago)?)\b/gi;

const ABSOLUTE_DATE =
  /\b(?:\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/g;

const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?\b/g;

const UUID =
  /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;

function stableIdFor(value: string, seen: Map<string, string>): string {
  const existing = seen.get(value);
  if (existing) return existing;
  const replacement = `id-${seen.size + 1}`;
  seen.set(value, replacement);
  return replacement;
}

/**
 * Sorts the tokens of a class attribute.
 *
 * The compilers emit the same classes in different orders for the same source,
 * so order is noise — but *membership* is not, and a dropped class is a real
 * regression the sorted list still shows.
 */
function sortClasses(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean).sort().join(" ");
}

function normalizeText(text: string): string {
  return text
    .replace(UUID, "«uuid»")
    .replace(ABSOLUTE_DATE, "«date»")
    .replace(CLOCK_TIME, "«time»")
    .replace(RELATIVE_TIME, "«ago»")
    .replace(/\s+/g, " ");
}

function normalizeElement(el: Element, ids: Map<string, string>): void {
  for (const attr of [...el.attributes]) {
    const name = attr.name;

    if (FRAMEWORK_ATTRIBUTES.some((pattern) => pattern.test(name))) {
      el.removeAttribute(name);
      continue;
    }

    if (name === "class") {
      const sorted = sortClasses(attr.value);
      if (sorted) el.setAttribute("class", sorted);
      else el.removeAttribute("class");
      continue;
    }

    if (VOLATILE_ATTRIBUTES.has(name) && attr.value) {
      if (!STABLE_IDS.has(attr.value)) {
        el.setAttribute(name, stableIdFor(attr.value, ids));
      }
      continue;
    }

    if (name === "style" && attr.value) {
      el.setAttribute("style", normalizeText(attr.value).trim());
      continue;
    }

    if (attr.value) el.setAttribute(name, normalizeText(attr.value).trim());
  }

  // Attribute order is compiler noise for the same reason class order is: Vue
  // and Solid emit the same set in different sequences, and a serialized diff
  // reports that as a change. Re-adding them in name order makes the
  // serialization canonical; membership and values still diff normally.
  const ordered = [...el.attributes]
    .map((attr) => [attr.name, attr.value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name] of ordered) el.removeAttribute(name);
  for (const [name, value] of ordered) el.setAttribute(name, value);

  for (const child of [...el.childNodes]) {
    if (child.nodeType === 8) {
      // Comment: both frameworks use these as render anchors. Vue writes
      // `v-if` / fragment markers, Solid writes `$` / `/`. None is content.
      child.remove();
    } else if (child.nodeType === 3) {
      const text = normalizeText(child.textContent ?? "");
      // A text node that is only layout whitespace carries no content, and the
      // two compilers indent templates differently. Dropping it costs the
      // "space between inline elements" signal, which is the right trade for a
      // structural snapshot — a *worded* difference still shows.
      if (text.trim()) child.textContent = text;
      else child.remove();
    } else if (child.nodeType === 1) {
      normalizeElement(child as Element, ids);
    }
  }
}

/**
 * A comparable serialization of `root`'s subtree.
 *
 * Pass a detached clone if the live tree matters — this mutates what it is
 * given, which is cheaper than cloning inside for the common case where the
 * caller already has a throwaway container.
 */
export function normalizeDom(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  normalizeElement(clone, new Map());

  return clone.innerHTML
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "<!---->")
    .join("\n");
}
