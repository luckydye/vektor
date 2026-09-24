import {
  decodeHtmlEntities,
  type HtmlNode,
  type HtmlTagNode,
  SyntaxKind,
} from "#utils/html.ts";
import type { SpecElement } from "./specs.ts";

/**
 * `SpecElement` over a parsed `html5parser` tag.
 *
 * The spec table reads elements through this interface so a single `parse`
 * function serves both sides: the server walks a string-level parse tree, the
 * editor walks real DOM elements (see `#editor/extensions/specSchema.ts`).
 */
export class TagElement implements SpecElement {
  readonly tag: string;
  private declarations: Map<string, string> | null = null;

  constructor(readonly node: HtmlTagNode) {
    this.tag = node.name.toLowerCase();
  }

  attr(name: string): string | null {
    for (const attribute of this.node.attributes ?? []) {
      if (attribute.name.value.toLowerCase() !== name) continue;
      // A valueless attribute (`<input checked>`) reads as "", matching
      // `Element.getAttribute`.
      return decodeHtmlEntities(attribute.value?.value ?? "");
    }
    return null;
  }

  style(property: string): string {
    this.declarations ??= parseStyle(this.attr("style") ?? "");
    return this.declarations.get(property) ?? "";
  }

  text(): string {
    return textContent(this.node.body ?? []);
  }

  children(): SpecElement[] {
    return (this.node.body ?? [])
      .filter((child): child is HtmlTagNode => child.type === SyntaxKind.Tag)
      .map((child) => new TagElement(child));
  }
}

/**
 * `SpecElement` over a tag name and a plain attribute map — an element as it
 * would be written out, without writing or re-parsing it. Used to ask whether
 * serializing something would produce markup the parser recognises again.
 */
export class AttrsElement implements SpecElement {
  private declarations: Map<string, string> | null = null;

  constructor(
    readonly tag: string,
    private readonly attrs: Record<string, string | number | null | undefined>,
  ) {}

  attr(name: string): string | null {
    const value = this.attrs[name];
    return value === null || value === undefined ? null : String(value);
  }

  style(property: string): string {
    this.declarations ??= parseStyle(this.attr("style") ?? "");
    return this.declarations.get(property) ?? "";
  }

  text(): string {
    return "";
  }

  children(): SpecElement[] {
    return [];
  }
}

/** `color: red; font-weight: bold` → a property lookup, properties lowercased. */
export function parseStyle(value: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of value.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    if (property) declarations.set(property, declaration.slice(separator + 1).trim());
  }
  return declarations;
}

export function textContent(nodes: HtmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === SyntaxKind.Text) {
      out += decodeHtmlEntities(node.value);
    } else if (node.type === SyntaxKind.Tag) {
      out += textContent(node.body ?? []);
    }
  }
  return out;
}
