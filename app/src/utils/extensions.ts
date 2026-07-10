import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { api, type ExtensionInfo, type ExtensionRoute } from "#api/client.ts";

export type { ExtensionInfo };

import { getActiveEditor } from "#editor/activeEditor.ts";
import {
  registerSuggestionProvider,
  type SuggestionItem,
  type SuggestionProvider,
  unregisterSuggestionProvider,
} from "#editor/extensions/ExtensionSuggestions.ts";
import { type ActionOptions, Actions } from "./actions.ts";

export type { SuggestionItem, SuggestionProvider };

/**
 * Extension API surface exposed to extension code
 *
 * Example extension frontend entry:
 * ```js
 * export function activate(ctx) {
 *   ctx.actions.register("my-extension.greet", {
 *     title: "Say G'day",
 *     run: async () => {
 *       const docs = await ctx.api.documents.get(ctx.spaceId);
 *       alert(`G'day! You have ${docs.length} documents.`);
 *     },
 *   });
 * }
 *
 * export function deactivate(ctx) {
 *   ctx.actions.unregister("my-extension.greet");
 * }
 * ```
 */
export type ViewRenderFn = (container: HTMLElement) => undefined | (() => void);

export type VektorGlobal = Omit<ExtensionContext, "extensionId"> & {
  /** All loaded extensions in the current space */
  extensions: Extensions;
};

export type ExtensionContext = {
  extensionId: string;
  spaceId: string;
  /** Current extension route path, if rendering a view */
  route: string | null;
  /** The active document ID, or null when no document is open */
  documentId: string | null;
  api: typeof api;
  actions: {
    register: (id: string, options: ActionOptions) => string;
    unregister: (id: string) => void;
  };
  views: {
    /** Register a view renderer for a route path */
    register: (path: string, render: ViewRenderFn) => void;
    unregister: (path: string) => void;
  };
  suggestions: {
    /** Register a suggestion provider with a trigger character */
    register: (id: string, provider: SuggestionProvider) => void;
    unregister: (id: string) => void;
  };
  /** Returns the active editor instance, or null if no editor is active */
  getActiveEditor: () => Editor | null;
  /**
   * The active collaboration session, or null when no collaborative document
   * is currently open (e.g. the extension is running outside a canvas/editor).
   * Use ydoc.getMap("game.<name>") to store synced game state. clientId is the
   * Yjs numeric peer ID — the peer with the lowest value is a stable host.
   */
  collaboration: { ydoc: Y.Doc; clientId: number } | null;
};

type LoadedExtension = {
  info: ExtensionInfo;
  module: ExtensionModule | null;
  viewModule: ExtensionModule | null;
  registeredActions: Set<string>;
  registeredViews: Map<string, ViewRenderFn>;
  registeredSuggestions: Set<string>;
  viewCleanup: (() => void) | null;
};

function getExtensionAssetUrl(
  spaceId: string,
  extensionId: string,
  assetPath: string,
  version: string | Date,
): string {
  return `/api/v1/spaces/${spaceId}/extensions/${extensionId}/assets/${assetPath}?v=${encodeURIComponent(String(version))}`;
}

type ExtensionModule = {
  activate?: (ctx: ExtensionContext) => void | Promise<void>;
  deactivate?: (ctx: ExtensionContext) => void | Promise<void>;
};

/**
 * Extensions lifecycle manager
 *
 * Responsible for:
 * - Fetching installed extensions from the API
 * - Loading frontend entry scripts
 * - Managing extension lifecycle (activate/deactivate)
 * - Tracking registered actions for cleanup
 */
export class Extensions {
  loaded = new Map<string, LoadedExtension>();
  spaceId: string | null = null;
  currentRoute: string | null = null;
  activeYdoc: Y.Doc | null = null;
  activeDocumentId: string | null = null;

  private readonly globalLoaded: LoadedExtension = {
    info: { id: "vektor" } as ExtensionInfo,
    module: null,
    viewModule: null,
    registeredActions: new Set(),
    registeredViews: new Map(),
    registeredSuggestions: new Set(),
    viewCleanup: null,
  };

  setActiveCollaboration(ydoc: Y.Doc | null) {
    this.activeYdoc = ydoc;
  }

  setActiveDocumentId(documentId: string | null) {
    this.activeDocumentId = documentId;
  }

  /**
   * Initialise extensions for a space
   * Fetches extension list and loads all frontend entries
   */
  private initPromise: Promise<void> | null = null;

  async init(spaceId: string): Promise<void> {
    // If already initializing or initialized for this space, wait for completion
    if (this.spaceId === spaceId && this.initPromise) {
      return this.initPromise;
    }

    // If switching spaces, unload previous extensions
    if (this.spaceId !== spaceId) {
      await this.unloadAll();
    }

    this.spaceId = spaceId;

    if (typeof window !== "undefined") {
      const ctx = this.createContext("vektor", this.globalLoaded);
      const { extensionId: _, ...descriptors } = Object.getOwnPropertyDescriptors(ctx);
      // @ts-expect-error
      globalThis.vektor = Object.defineProperties({ extensions: this }, descriptors);
    }

    this.initPromise = (async () => {
      const cached = await api.extensions.getCached(spaceId);
      // loadExtensions announces cached manifest routes before it waits for
      // frontend module imports, allowing the sidebar to render from IndexedDB
      // on a warm start.
      const cachedLoads = cached
        ? this.loadExtensions(cached.extensions)
        : Promise.resolve();

      const remoteExtensions = await this.fetchExtensions(spaceId);
      await cachedLoads;
      await this.loadExtensions(remoteExtensions, { reconcile: true });
    })();

    return this.initPromise;
  }

  /**
   * Fetch extension list from API
   */
  async fetchExtensions(spaceId: string): Promise<ExtensionInfo[]> {
    let result: {
      extensions: ExtensionInfo[];
      errors: import("../api/ApiClient.ts").ExtensionManifestError[];
    };
    try {
      result = await api.extensions.get(spaceId);
    } catch (err) {
      // Silently fail if user doesn't have access (non-owners)
      if (err instanceof Error && err.message.includes("403")) return [];
      throw err;
    }

    for (const err of result.errors) {
      console.warn(
        `Extension '${err.id}' could not be loaded from manifest: ${err.error}`,
      );
    }

    return result.extensions;
  }

  private notifyExtensionsLoaded(): void {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("extensions:loaded"));
    }
  }

  private async loadExtensions(
    extensionInfos: ExtensionInfo[],
    options?: { reconcile?: boolean },
  ): Promise<void> {
    if (options?.reconcile) {
      const currentIds = new Set(extensionInfos.map((extension) => extension.id));
      for (const extensionId of [...this.loaded.keys()]) {
        if (!currentIds.has(extensionId)) {
          await this.unloadExtension(extensionId);
        }
      }
    }

    // Calling an async function runs it through its first await immediately.
    // loadExtension records manifest metadata before importing its frontend
    // module, so the sidebar can use the routes below without waiting on that
    // network work.
    const loading = extensionInfos.map((extension) => this.loadExtension(extension));
    this.notifyExtensionsLoaded();
    await Promise.all(loading);
    this.notifyExtensionsLoaded();
  }

  /**
   * Load a single extension's frontend entry
   */
  async loadExtension(info: ExtensionInfo): Promise<void> {
    const existing = this.loaded.get(info.id);
    if (existing) {
      if (!info.enabled) {
        await this.unloadExtension(info.id);
        return;
      }
      // The manifest is canonical server data. Update menu routes and other
      // metadata even when the frontend module has already been loaded.
      existing.info = info;
      return;
    }

    if (!info.enabled) {
      return;
    }

    const loaded: LoadedExtension = {
      info,
      module: null,
      viewModule: null,
      registeredActions: new Set(),
      registeredViews: new Map(),
      registeredSuggestions: new Set(),
      viewCleanup: null,
    };

    this.loaded.set(info.id, loaded);

    if (!info.entries.frontend || !this.spaceId) {
      return;
    }

    const assetUrl = getExtensionAssetUrl(
      this.spaceId,
      info.id,
      info.entries.frontend,
      info.updatedAt,
    );

    try {
      const module = (await import(/* @vite-ignore */ assetUrl)) as ExtensionModule;
      loaded.module = module;

      const ctx = this.createContext(info.id, loaded);

      if (module.activate) {
        await module.activate(ctx);
      }
    } catch (err) {
      console.error(`Failed to load extension '${info.id}':`, err);
    }
  }

  /**
   * Unload a single extension
   */
  async unloadExtension(extensionId: string): Promise<void> {
    const loaded = this.loaded.get(extensionId);
    if (!loaded) {
      return;
    }

    const ctx = this.createContext(extensionId, loaded);

    // Call deactivate if available
    if (loaded.module?.deactivate) {
      try {
        await loaded.module.deactivate(ctx);
      } catch (err) {
        console.error(`Error deactivating extension '${extensionId}':`, err);
      }
    }

    // Cleanup view if active
    if (loaded.viewCleanup) {
      try {
        loaded.viewCleanup();
      } catch (err) {
        console.error(`Error cleaning up view for '${extensionId}':`, err);
      }
      loaded.viewCleanup = null;
    }

    // Cleanup any actions that weren't unregistered
    for (const actionId of loaded.registeredActions) {
      Actions.unregister(actionId);
    }

    // Cleanup any suggestions that weren't unregistered
    for (const suggestionId of loaded.registeredSuggestions) {
      unregisterSuggestionProvider(suggestionId);
    }

    this.loaded.delete(extensionId);
  }

  /**
   * Unload all extensions
   */
  async unloadAll(): Promise<void> {
    const extensionIds = Array.from(this.loaded.keys());

    for (const id of extensionIds) {
      await this.unloadExtension(id);
    }

    this.spaceId = null;
  }

  /**
   * Reload a specific extension (useful after updates)
   */
  async reloadExtension(extensionId: string): Promise<void> {
    const loaded = this.loaded.get(extensionId);
    if (!loaded || !this.spaceId) {
      return;
    }

    await this.unloadExtension(extensionId);

    // Refetch extension info in case it was updated
    const extensions = await this.fetchExtensions(this.spaceId);
    const updated = extensions.find((e) => e.id === extensionId);

    if (updated) {
      await this.loadExtension(updated);
    }
  }

  /**
   * Create extension context with scoped API surface
   */
  createContext(extensionId: string, loaded: LoadedExtension): ExtensionContext {
    if (!this.spaceId) {
      throw new Error("Cannot create context without spaceId");
    }

    const instance = this;
    return {
      extensionId,
      spaceId: this.spaceId,
      get route() {
        return instance.currentRoute;
      },
      get documentId() {
        return instance.activeDocumentId;
      },
      api,
      actions: {
        register: (id: string, options: ActionOptions) => {
          // Prefix action ID with extension ID for namespacing
          const fullId = id.startsWith(`${extensionId}.`) ? id : `${extensionId}.${id}`;
          loaded.registeredActions.add(fullId);
          return Actions.register(fullId, options);
        },
        unregister: (id: string) => {
          const fullId = id.startsWith(`${extensionId}.`) ? id : `${extensionId}.${id}`;
          loaded.registeredActions.delete(fullId);
          Actions.unregister(fullId);
        },
      },
      views: {
        register: (path: string, render: ViewRenderFn) => {
          loaded.registeredViews.set(path, render);
        },
        unregister: (path: string) => {
          loaded.registeredViews.delete(path);
        },
      },
      suggestions: {
        register: (id: string, provider: SuggestionProvider) => {
          const fullId = id.startsWith(`${extensionId}.`) ? id : `${extensionId}.${id}`;
          loaded.registeredSuggestions.add(fullId);
          registerSuggestionProvider(fullId, provider);
        },
        unregister: (id: string) => {
          const fullId = id.startsWith(`${extensionId}.`) ? id : `${extensionId}.${id}`;
          loaded.registeredSuggestions.delete(fullId);
          unregisterSuggestionProvider(fullId);
        },
      },
      getActiveEditor,
      get collaboration() {
        const ydoc = instance.activeYdoc;
        return ydoc ? { ydoc, clientId: ydoc.clientID } : null;
      },
    };
  }

  /**
   * Get list of loaded extensions
   */
  getLoaded(): ExtensionInfo[] {
    return Array.from(this.loaded.values()).map((l) => l.info);
  }

  /**
   * Get all menu links from loaded extensions (routes with menuItem defined)
   */
  getMenuLinks(): Array<{
    extensionId: string;
    route: string;
    title: string;
    icon?: string;
  }> {
    const links: Array<{
      extensionId: string;
      route: string;
      title: string;
      icon?: string;
    }> = [];
    for (const loaded of this.loaded.values()) {
      if (!loaded.info.routes) continue;
      for (const route of loaded.info.routes) {
        if (route.menuItem) {
          links.push({
            extensionId: loaded.info.id,
            route: route.path,
            title: route.menuItem.title,
            icon: route.menuItem.icon,
          });
        }
      }
    }
    return links;
  }

  /**
   * Find extension that handles a given route path
   */
  findExtensionForRoute(
    routePath: string,
  ): { extension: ExtensionInfo; route: ExtensionRoute } | null {
    for (const loaded of this.loaded.values()) {
      if (!loaded.info.routes) continue;
      for (const route of loaded.info.routes) {
        if (route.path === routePath) {
          return { extension: loaded.info, route };
        }
      }
    }
    return null;
  }

  /**
   * Render an extension view into a container
   */
  async renderView(
    extensionId: string,
    routePath: string,
    container: HTMLElement,
  ): Promise<boolean> {
    const loaded = this.loaded.get(extensionId);
    if (!loaded) {
      console.error(`Extension '${extensionId}' not loaded`);
      return false;
    }

    // Cleanup previous view if any
    if (loaded.viewCleanup) {
      loaded.viewCleanup();
      loaded.viewCleanup = null;
    }

    this.currentRoute = routePath;

    // Load view module if not loaded yet (separate from frontend module)
    if (!loaded.viewModule && loaded.info.entries.view && this.spaceId) {
      const assetUrl = getExtensionAssetUrl(
        this.spaceId,
        extensionId,
        loaded.info.entries.view,
        loaded.info.updatedAt,
      );
      try {
        const module = (await import(/* @vite-ignore */ assetUrl)) as ExtensionModule;
        loaded.viewModule = module;
        const ctx = this.createContext(extensionId, loaded);
        if (module.activate) {
          await module.activate(ctx);
        }
      } catch (err) {
        console.error(`Failed to load view module for '${extensionId}':`, err);
        return false;
      }
    }

    const render = loaded.registeredViews.get(routePath);
    if (!render) {
      console.error(
        `Extension '${extensionId}' has no view registered for route '${routePath}'`,
      );
      return false;
    }

    try {
      const cleanup = render(container);
      if (typeof cleanup === "function") {
        loaded.viewCleanup = cleanup;
      }
      return true;
    } catch (err) {
      console.error(
        `Error rendering view for '${extensionId}' route '${routePath}':`,
        err,
      );
      return false;
    }
  }

  /**
   * Render an extension view into a container without tracking cleanup globally.
   * Returns a cleanup function, or null if the view could not be rendered.
   * Suitable for rendering multiple independent inline instances.
   */
  async renderInlineView(
    extensionId: string,
    routePath: string,
    container: HTMLElement,
  ): Promise<(() => void) | null> {
    const loaded = this.loaded.get(extensionId);
    if (!loaded) {
      console.error(`Extension '${extensionId}' not loaded`);
      return null;
    }

    // Load view module if not loaded yet
    if (!loaded.viewModule && loaded.info.entries.view && this.spaceId) {
      const assetUrl = getExtensionAssetUrl(
        this.spaceId,
        extensionId,
        loaded.info.entries.view,
        loaded.info.updatedAt,
      );
      try {
        const module = (await import(/* @vite-ignore */ assetUrl)) as ExtensionModule;
        loaded.viewModule = module;
        const ctx = this.createContext(extensionId, loaded);
        if (module.activate) {
          await module.activate(ctx);
        }
      } catch (err) {
        console.error(`Failed to load view module for '${extensionId}':`, err);
        return null;
      }
    }

    const renderFn = loaded.registeredViews.get(routePath);
    if (!renderFn) {
      console.error(
        `Extension '${extensionId}' has no view registered for route '${routePath}'`,
      );
      return null;
    }

    try {
      const cleanup = renderFn(container);
      return typeof cleanup === "function" ? cleanup : () => {};
    } catch (err) {
      console.error(
        `Error rendering inline view for '${extensionId}' route '${routePath}':`,
        err,
      );
      return null;
    }
  }

  /**
   * Get all routes with specific placement
   */
  getRoutesWithPlacement(
    placement: "page" | "home-top" | "document",
  ): Array<{ extensionId: string; route: ExtensionRoute }> {
    const routes: Array<{ extensionId: string; route: ExtensionRoute }> = [];
    for (const loaded of this.loaded.values()) {
      if (!loaded.info.routes) continue;
      for (const route of loaded.info.routes) {
        const placements = route.placements || ["page"];
        if (placements.includes(placement)) {
          routes.push({
            extensionId: loaded.info.id,
            route,
          });
        }
      }
    }
    return routes;
  }
}

// Singleton instance
export const extensions = new Extensions();

const HTMLElement = globalThis.HTMLElement || class {};

export class ExtensionViewElement extends HTMLElement {
  root: HTMLElement | undefined = undefined;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open", delegatesFocus: true });
    shadow.innerHTML = `
      <style>
        :host {
          display: block;
        }
      </style>
    `;

    const root = document.createElement("div");
    root.style.height = "100%";
    root.style.width = "100%";
    shadow.appendChild(root);
    this.root = root;
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("extension-view", ExtensionViewElement);
}

class ExtensionViewBlockElement extends HTMLElement {
  private cleanup: (() => void) | null = null;

  connectedCallback() {
    this.tryRender();
    window.addEventListener("extensions:loaded", this.tryRender);
  }

  disconnectedCallback() {
    window.removeEventListener("extensions:loaded", this.tryRender);
    if (this.cleanup) {
      this.cleanup();
      this.cleanup = null;
    }
  }

  private tryRender = () => {
    if (this.cleanup) return;
    const extensionId = this.getAttribute("data-extension-id");
    const routePath = this.getAttribute("data-route-path");
    if (!extensionId || !routePath) return;

    extensions.renderInlineView(extensionId, routePath, this).then((fn) => {
      if (!this.isConnected) {
        fn?.();
        return;
      }
      if (fn) {
        window.removeEventListener("extensions:loaded", this.tryRender);
        this.cleanup = fn;
      }
    });
  };
}

if (typeof customElements !== "undefined") {
  customElements.define("extension-view-block", ExtensionViewBlockElement);
}
