import { Actions, type ActionOptions } from "./actions.ts";
import { api, type ExtensionRoute } from "../api/client.ts";
import type { Editor } from "@tiptap/core";
import {
  registerSuggestionProvider,
  unregisterSuggestionProvider,
  type SuggestionProvider,
  type SuggestionItem,
} from "../editor/extensions/ExtensionSuggestions.ts";

export type { SuggestionProvider, SuggestionItem };

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
export type ViewRenderFn = (container: HTMLElement) => void | (() => void);

export type ExtensionContext = {
  extensionId: string;
  spaceId: string;
  /** Current extension route path, if rendering a view */
  route: string | null;
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
  /** Extension-scoped key-value storage */
  storage: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
    list: (prefix?: string) => Promise<Array<{ key: string; value: string }>>;
  };
  /** Returns the active editor instance, or null if no editor is active */
  getActiveEditor: () => Editor | null;
};

export type ExtensionInfo = {
  id: string;
  name: string;
  version: string;
  description?: string;
  entries: {
    frontend?: string;
    view?: string;
  };
  routes?: ExtensionRoute[];
  jobs?: Array<{
    id: string;
    name: string;
    inputs?: Record<string, { type: string; required?: boolean }>;
    outputs?: Record<string, { type: string; required?: boolean }>;
  }>;
  dataSources?: Array<{
    id: string;
    name: string;
    description?: string;
    jobId: string;
    inputs?: Record<string, { type: string; required?: boolean }>;
    cacheTtlMs?: number;
  }>;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
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

    this.initPromise = (async () => {
      const extensions = await this.fetchExtensions(spaceId);

      for (const ext of extensions) {
        await this.loadExtension(ext);
      }

      // Notify listeners that extensions have loaded
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("extensions:loaded"));
      }
    })();

    return this.initPromise;
  }

  /**
   * Fetch extension list from API
   */
  async fetchExtensions(spaceId: string): Promise<ExtensionInfo[]> {
    const response = await fetch(`/api/v1/spaces/${spaceId}/extensions`);

    if (!response.ok) {
      // Silently fail if user doesn't have access (non-owners)
      if (response.status === 403) {
        return [];
      }
      throw new Error(`Failed to fetch extensions: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Load a single extension's frontend entry
   */
  async loadExtension(info: ExtensionInfo): Promise<void> {
    if (this.loaded.has(info.id)) {
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

    const assetUrl = `/api/v1/spaces/${this.spaceId}/extensions/${info.id}/assets/${info.entries.frontend}`;

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

    return {
      extensionId,
      spaceId: this.spaceId,
      route: this.currentRoute,
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
      storage: {
        get: async (key: string) => {
          const result = await api.extensions.storage.get(
            this.spaceId!,
            extensionId,
            key,
          );
          return result?.value ?? null;
        },
        set: async (key: string, value: string) => {
          await api.extensions.storage.set(this.spaceId!, extensionId, key, value);
        },
        delete: async (key: string) => {
          await api.extensions.storage.delete(this.spaceId!, extensionId, key);
        },
        list: async (prefix?: string) => {
          const entries = await api.extensions.storage.list(
            this.spaceId!,
            extensionId,
            prefix,
          );
          return entries.map(({ key, value }) => ({ key, value }));
        },
      },
      getActiveEditor: () => window.__editor ?? null,
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
      const assetUrl = `/api/v1/spaces/${this.spaceId}/extensions/${extensionId}/assets/${loaded.info.entries.view}`;
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
   * Get all routes with specific placement
   */
  getRoutesWithPlacement(
    placement: "page" | "home-top",
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

// Expose globally for debugging
if (typeof window !== "undefined") {
  // @ts-expect-error
  globalThis.Extensions = extensions;
}

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

customElements.define("extension-view", ExtensionViewElement);
