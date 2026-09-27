import { type Attributes, mergeAttributes } from "@tiptap/core";
import type {
  DOMOutputSpec,
  Mark,
  Node,
  ParseRule,
  TagParseRule,
} from "@tiptap/pm/model";
import {
  type AttrSpec,
  type Attrs,
  attrDefault,
  CONTENT_HOLE,
  type DocNode,
  type HtmlAttrs,
  type Matcher,
  markSpec,
  nodeSpec,
  type RenderTree,
  type Spec,
  type SpecElement,
  selectorFor,
  specFor,
} from "#documents/schema/specs.ts";

/**
 * The editor half of the schema.
 *
 * Extensions do not declare `parseHTML`, `renderHTML` or `addAttributes`
 * themselves — they take them from `#documents/schema/specs.ts` through the
 * builders here, so the editor and the server serialize the same documents by
 * construction rather than by two implementations agreeing. What stays in each
 * extension is its behaviour: commands, keymaps, input rules, node views.
 */

/** `SpecElement` over a real DOM element. */
class DomElement implements SpecElement {
  readonly tag: string;

  constructor(private readonly element: HTMLElement) {
    this.tag = element.tagName.toLowerCase();
  }

  attr(name: string): string | null {
    return this.element.getAttribute(name);
  }

  style(property: string): string {
    return this.element.style?.getPropertyValue(property) ?? "";
  }

  text(): string {
    return this.element.textContent ?? "";
  }

  children(): SpecElement[] {
    return Array.from(this.element.children).map(
      (child) => new DomElement(child as HTMLElement),
    );
  }
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function attributeFor(name: string, attr: AttrSpec): Attributes[string] {
  return {
    default: attrDefault(attr),
    ...(attr.rendered === false ? { rendered: false } : {}),
    ...(attr.parse
      ? { parseHTML: (element: HTMLElement) => attr.parse?.(new DomElement(element)) }
      : {}),
    ...(attr.render
      ? { renderHTML: (attrs: Attrs) => attr.render?.(attrs[name], attrs) ?? {} }
      : {}),
  };
}

export function specAttributes(name: string): Attributes {
  const spec = specFor(name);
  const attributes: Attributes = {};
  for (const [attr, definition] of Object.entries(spec?.attrs ?? {})) {
    attributes[attr] = attributeFor(attr, definition);
  }
  return attributes;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function ruleFor(spec: Spec, matcher: Matcher): TagParseRule {
  const getAttrs = (element: HTMLElement | string) => {
    if (typeof element === "string") return null;
    const el = new DomElement(element);
    if (matcher.guard && !matcher.guard(el)) return false;
    return (matcher.attrs?.(el) as Record<string, unknown> | undefined) ?? null;
  };

  return {
    tag: selectorFor(matcher),
    ...(matcher.priority === undefined ? {} : { priority: matcher.priority }),
    ...(spec.kind === "node" && spec.verbatim
      ? { preserveWhitespace: "full" as const }
      : {}),
    getAttrs,
  };
}

/** Tag rules only — the form a node's `parseHTML` has to return. */
export function specParseRules(name: string): TagParseRule[] {
  const spec = specFor(name);
  if (!spec) return [];
  return (spec.match ?? []).map((matcher) => ruleFor(spec, matcher));
}

/**
 * A mark's rules: its tags, then the inline styles that stand for it, so pasted
 * markup keeps its formatting when it arrives without the matching element.
 */
function markParseRules(name: string): ParseRule[] {
  const spec = markSpec(name);
  if (!spec) return [];
  return [
    ...specParseRules(name),
    ...(spec.styles ?? []).map(
      (style): ParseRule => ({ style: `${style.property}=${style.value}` }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function toOutputSpec(tree: RenderTree): DOMOutputSpec {
  const children = (tree.children ?? []).map((child) => {
    if (child === CONTENT_HOLE) return 0;
    return typeof child === "string" ? child : toOutputSpec(child);
  });
  return [tree.tag, tree.attrs ?? {}, ...children] as DOMOutputSpec;
}

function render(spec: Spec, attrs: Attrs, html: HtmlAttrs, node?: Node): DOMOutputSpec {
  const tree = spec.render?.({
    attrs,
    html,
    // Only the renderers that read their own content pay for materializing it.
    node: spec.needsNode ? (node?.toJSON() as DocNode | undefined) : undefined,
  }) ?? {
    tag: spec.match?.[0]?.tag ?? spec.name,
    attrs: html,
    ...(spec.kind === "mark" || spec.content ? { children: [CONTENT_HOLE] } : {}),
  };
  return toOutputSpec(tree);
}

export function specRenderNode(
  name: string,
  props: { node: Node; HTMLAttributes: Record<string, unknown> },
  optionAttributes?: Record<string, unknown>,
): DOMOutputSpec {
  const spec = nodeSpec(name);
  if (!spec) return ["div", props.HTMLAttributes, 0];
  const html = mergeAttributes(optionAttributes ?? {}, props.HTMLAttributes) as HtmlAttrs;
  return render(spec, props.node.attrs, html, props.node);
}

export function specRenderMark(
  name: string,
  props: { mark: Mark; HTMLAttributes: Record<string, unknown> },
  optionAttributes?: Record<string, unknown>,
): DOMOutputSpec {
  const spec = markSpec(name);
  if (!spec) return ["span", props.HTMLAttributes, 0];
  const html = mergeAttributes(optionAttributes ?? {}, props.HTMLAttributes) as HtmlAttrs;
  return render(spec, props.mark.attrs, html);
}

// ---------------------------------------------------------------------------
// Extension configuration
// ---------------------------------------------------------------------------

/**
 * `this` inside a generated `renderHTML`. Deliberately as loose as it can be:
 * every extension has differently typed options, and all that is wanted here is
 * the optional `HTMLAttributes` a caller may have configured.
 */
type WithOptions = { options: unknown };

function configuredAttributes(context: WithOptions): Record<string, unknown> {
  const options = context.options as
    | { HTMLAttributes?: Record<string, unknown> }
    | undefined;
  return options?.HTMLAttributes ?? {};
}

/**
 * The schema and serialization half of a node extension, from the table.
 *
 * `doc` and `text` have no markup of their own; giving them a `renderHTML`
 * would put ProseMirror's text serialization behind a `<text>` element, so the
 * parse and render halves are omitted for specs with neither.
 */
export function nodeFromSpec(name: string) {
  const spec = nodeSpec(name);
  if (!spec) throw new Error(`no node spec named "${name}"`);
  const serialized = Boolean(spec.match || spec.render);

  return {
    ...(spec.group === undefined ? {} : { group: spec.group }),
    ...(spec.content === undefined ? {} : { content: spec.content }),
    ...(spec.marks === undefined ? {} : { marks: spec.marks }),
    ...(spec.inline ? { inline: true } : {}),
    ...(spec.atom ? { atom: true } : {}),
    ...(spec.defining ? { defining: true } : {}),
    ...(spec.isolating ? { isolating: true } : {}),
    ...(spec.draggable ? { draggable: true } : {}),
    ...(spec.selectable === false ? { selectable: false } : {}),
    ...(spec.code ? { code: true } : {}),
    ...(spec.topNode ? { topNode: true } : {}),
    ...(spec.attrs ? { addAttributes: () => specAttributes(name) } : {}),
    ...(serialized
      ? {
          parseHTML: () => specParseRules(name),
          renderHTML(
            this: WithOptions,
            props: { node: Node; HTMLAttributes: Record<string, unknown> },
          ) {
            return specRenderNode(name, props, configuredAttributes(this));
          },
        }
      : {}),
  };
}

/** The schema and serialization half of a mark extension, from the table. */
export function markFromSpec(name: string) {
  const spec = markSpec(name);
  if (!spec) throw new Error(`no mark spec named "${name}"`);

  return {
    ...(spec.excludes === undefined ? {} : { excludes: spec.excludes }),
    ...(spec.code ? { code: true, exitable: true } : {}),
    ...(spec.keepOnSplit === undefined ? {} : { keepOnSplit: spec.keepOnSplit }),
    ...(spec.attrs ? { addAttributes: () => specAttributes(name) } : {}),
    parseHTML: () => markParseRules(name),
    renderHTML(
      this: WithOptions,
      props: { mark: Mark; HTMLAttributes: Record<string, unknown> },
    ) {
      return specRenderMark(name, props, configuredAttributes(this));
    },
  };
}
