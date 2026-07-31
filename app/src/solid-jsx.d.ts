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
      "on:tab-selected"?: (event: Event) => void;
      "attr:hidden"?: string | undefined;
      "attr:enabled"?: string | undefined;
      // `prop:` assigns a DOM property instead of an attribute — the only way
      // to hand a custom element an object.
      "prop:user"?: unknown;
      "attr:value"?: string;
      snap?: boolean;
      mode?: string;
      "week-start"?: string;
      "attr:opened"?: string | undefined;
      fill?: boolean;
      showdelay?: string;
      name?: string;
      hidedelay?: string;
      size?: string;
      "asset-id"?: string | undefined;
      "user-id"?: string | undefined;
    }

    interface IntrinsicElements {
      "a-blur": CustomElementAttributes;
      "document-attachment": CustomElementAttributes;
      "canvas-presence-cursor": CustomElementAttributes;
      "vektor-canvas": CustomElementAttributes;
      "extension-view": CustomElementAttributes;
      "rich-text-editor": CustomElementAttributes;
      "document-toolbar": CustomElementAttributes;
      "vektor-cosmetic": CustomElementAttributes;
      "wiki-drawer": CustomElementAttributes;
      "category-target": CustomElementAttributes;
      "page-target": CustomElementAttributes;
      "document-view": CustomElementAttributes;
      "a-list-item": CustomElementAttributes;
      "inset-view": CustomElementAttributes;
      "a-shortcut": CustomElementAttributes;
      "a-tabs": CustomElementAttributes;
      "a-tabs-list": CustomElementAttributes;
      "a-tabs-panel": CustomElementAttributes;
      "a-tabs-tab": CustomElementAttributes;
      "a-color-picker": CustomElementAttributes;
      "a-list": CustomElementAttributes;
      "a-calendar": CustomElementAttributes;
      "a-expandable": CustomElementAttributes;
      "a-track": CustomElementAttributes;
      "a-popover": CustomElementAttributes;
      "a-popover-trigger": CustomElementAttributes;
      "a-popover-arrow": CustomElementAttributes;
      "vektor-avatar": CustomElementAttributes;
      "wiki-scroll": CustomElementAttributes;
    }
  }
}
