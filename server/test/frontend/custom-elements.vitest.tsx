import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Which namespace a custom-element binding needs.
 *
 * Solid sets a **property** for a dynamic binding when the element has one,
 * and writes a **static** string straight into the template as an attribute.
 * Neither is universally right: an element that only observes attributes
 * ignores the property, and an element whose value is a property-only setter
 * ignores the attribute. Both failures are silent — nothing throws, the value
 * just never arrives.
 *
 * These fixtures pin the rules down so a future binding can be checked against
 * a test rather than against a guess. The two shapes are the ones our own
 * elements actually use.
 */

/** Property-only, like `document-view.html` and `rich-text-editor.value`. */
class PropOnlyElement extends HTMLElement {
  received: string | null = null;
  set payload(value: string) {
    this.received = value;
  }
}

/**
 * Getter over an observed attribute, like `code-editor.language`.
 *
 * The getter has no setter, which is the whole hazard: a dynamic binding named
 * after it is a property assignment, and assigning to a getter-only property
 * throws in strict mode — which every module is.
 */
class AttrOnlyElement extends HTMLElement {
  static get observedAttributes() {
    return ["mode", "user-id"];
  }
  get mode() {
    return this.getAttribute("mode") ?? "default";
  }
}

customElements.define("test-prop-only", PropOnlyElement);
customElements.define("test-attr-only", AttrOnlyElement);

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function mount(node: () => unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  disposers.push(render(node as never, host));
  return host;
}

describe("custom element binding namespaces", () => {
  it("an un-namespaced dynamic attribute is dropped entirely", () => {
    // Not "set as a property" and not "set as an attribute" — gone. This
    // silently unhooks every page-target and avatar.
    const value = () => "doc_1";
    const host = mount(() => <test-attr-only data-document-id={value()} />);
    const el = host.firstElementChild as HTMLElement;
    expect(el.getAttribute("data-document-id")).toBeNull();
    expect(el.outerHTML).toBe("<test-attr-only></test-attr-only>");
  });

  it("prop: reaches a property-only setter", () => {
    const host = mount(() => <test-prop-only prop:payload="from-prop" />);
    const el = host.firstElementChild as PropOnlyElement;
    expect(el.received).toBe("from-prop");
  });

  it("attr: does not reach a property-only setter", () => {
    // The failure this file exists to catch: the attribute lands, the element
    // never looks at it, and nothing reports a problem.
    const host = mount(() => <test-prop-only attr:payload="from-attr" />);
    const el = host.firstElementChild as PropOnlyElement;
    expect(el.getAttribute("payload")).toBe("from-attr");
    expect(el.received).toBeNull();
  });

  it("a static string lands as an attribute, so a getter over one works", () => {
    const host = mount(() => <test-attr-only mode="review" />);
    const el = host.firstElementChild as AttrOnlyElement;
    expect(el.getAttribute("mode")).toBe("review");
    expect(el.mode).toBe("review");
  });

  // The most common shape in the codebase: `user-id={someAccessor()}` on
  // <vektor-avatar>. A hyphenated name cannot be a property, so Solid has
  // nowhere to put it but an attribute — which is what the element reads.
  it("attr: is what makes user-id reach <vektor-avatar>", () => {
    const value = () => "user_ada";
    const host = mount(() => <test-attr-only attr:user-id={value()} />);
    const el = host.firstElementChild as AttrOnlyElement;
    expect(el.getAttribute("user-id")).toBe("user_ada");
  });

  // Why `code-editor`'s `language` is bound as a static string and not an
  // expression. Solid assigns a property for a dynamic binding whose name
  // matches one, and a getter with no setter rejects the assignment — so this
  // does not silently do nothing, it takes the render down.
  it("attr: makes a dynamic data-* land, which page-target depends on", () => {
    const value = () => "doc_1";
    const host = mount(() => <test-attr-only attr:data-document-id={value()} />);
    const el = host.firstElementChild as HTMLElement;
    expect(el.getAttribute("data-document-id")).toBe("doc_1");
  });

  it("a dynamic name matching a getter-only property throws", () => {
    const value = () => "review";
    expect(() => mount(() => <test-attr-only mode={value()} />)).toThrow(
      /readonly|setter/i,
    );
  });

  it("attr: reaches an observed attribute when the value is dynamic", () => {
    const value = () => "review";
    const host = mount(() => <test-attr-only attr:mode={value()} />);
    const el = host.firstElementChild as AttrOnlyElement;
    expect(el.mode).toBe("review");
  });
});
