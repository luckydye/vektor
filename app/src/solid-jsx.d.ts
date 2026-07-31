import type { JSX } from "solid-js";

/**
 * The custom elements Solid components render.
 *
 * Solid typechecks intrinsic elements against this table, and an undeclared tag
 * is an error rather than a passthrough — which is the useful behaviour, since
 * a typo in a custom-element name otherwise renders an inert unknown element
 * with no warning anywhere.
 */
declare module "solid-js" {
  namespace JSX {
    interface CustomElementAttributes extends JSX.HTMLAttributes<HTMLElement> {
      enabled?: boolean;
      placements?: string;
      slot?: string;
      // `on:` bindings are how Solid attaches a listener for an event name it
      // does not know, which is every event a custom element dispatches.
      "on:exit"?: (event: Event) => void;
      "on:change"?: (event: Event) => void;
      "attr:hidden"?: string | undefined;
      "attr:enabled"?: string | undefined;
      // `prop:` assigns a DOM property instead of an attribute — the only way
      // to hand a custom element an object.
      "prop:user"?: unknown;
      "attr:value"?: string;
      showdelay?: string;
      name?: string;
      hidedelay?: string;
    }

    interface IntrinsicElements {
      "a-blur": CustomElementAttributes;
      "a-shortcut": CustomElementAttributes;
      "a-color-picker": CustomElementAttributes;
      "a-list": CustomElementAttributes;
      "a-popover": CustomElementAttributes;
      "a-popover-trigger": CustomElementAttributes;
      "vektor-avatar": CustomElementAttributes;
      "wiki-scroll": CustomElementAttributes;
    }
  }
}
