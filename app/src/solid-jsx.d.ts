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
      "on:hide"?: (event: Event) => void;
      "on:show"?: (event: Event) => void;
      "on:change"?: (event: Event) => void;
      "on:tab-selected"?: (event: Event) => void;
      "on:presence-change"?: (event: Event) => void;
      "on:selection-change"?: (event: Event) => void;
      "on:editor-focus"?: (event: Event) => void;
      "on:editor-blur"?: (event: Event) => void;
      "on:content-change"?: (event: Event) => void;
      "on:editor-keydown"?: (event: Event) => void;
      "on:editor-paste"?: (event: Event) => void;
      "on:task-toggle-request"?: (event: Event) => void;
      "attr:hidden"?: string | undefined;
      "attr:enabled"?: string | undefined;
      // `prop:` assigns a DOM property instead of an attribute — the only way
      // to hand a custom element an object.
      "prop:user"?: unknown;
      // `html` and `value` on our own elements are property-only setters, not
      // observed attributes — `attr:` would be silently dropped.
      "prop:html"?: string;
      "prop:payload"?: string;
      "attr:payload"?: string;
      "attr:mode"?: string;
      mode?: string;
      "prop:value"?: string;
      "attr:value"?: string | undefined;
      // Every dynamic attribute on a custom element needs the namespace: Solid
      // drops an un-namespaced one entirely. See custom-elements.vitest.tsx.
      "attr:user-id"?: string | undefined;
      // Presence of the attribute is the signal, so "" is the way to set it.
      "attr:credential"?: string | undefined;
      "attr:asset-id"?: string | undefined;
      "attr:data-document-id"?: string | undefined;
      "attr:data-document-type"?: string | undefined;
      "attr:data-space-id"?: string | undefined;
      "attr:data-document-url"?: string | undefined;
      "attr:data-category-id"?: string | undefined;
      "attr:data-shortcut"?: string | undefined;
      "attr:data-comments-enabled"?: string | undefined;
      "attr:aria-label"?: string | undefined;
      "attr:placeholder"?: string | undefined;
      "attr:mentions"?: string | undefined;
      "attr:inline-document-references"?: string | undefined;
      "attr:space-id"?: string | undefined;
      "attr:document-id"?: string | undefined;
      "attr:html"?: string | undefined;
      snap?: boolean;
      language?: string;
      mode?: string;
      "week-start"?: string;
      "attr:opened"?: string | undefined;
      "attr:selected"?: string | undefined;
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
      "code-editor": CustomElementAttributes;
      "document-toolbar": CustomElementAttributes;
      "table-view": CustomElementAttributes;
      "document-statusbar": CustomElementAttributes;
      "vektor-cosmetic": CustomElementAttributes;
      "wiki-drawer": CustomElementAttributes;
      "drawer-track": CustomElementAttributes;
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
      "a-lightbox": CustomElementAttributes;
      "a-track": CustomElementAttributes;
      "a-popover": CustomElementAttributes;
      "a-popover-trigger": CustomElementAttributes;
      "a-popover-arrow": CustomElementAttributes;
      "vektor-avatar": CustomElementAttributes;
      // Fixtures for test/frontend/custom-elements.vitest.tsx.
      "test-prop-only": CustomElementAttributes;
      "test-attr-only": CustomElementAttributes;
    }
  }
}
