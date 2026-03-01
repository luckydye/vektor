/**
 * Extension Manifest Schema
 *
 * Example manifest.json:
 * {
 *   "id": "my-extension",
 *   "name": "My Extension",
 *   "version": "1.0.0",
 *   "entries": {
 *     "frontend": "dist/main.js"
 *   }
 * }
 */

export type ExtensionManifest = {
  /** Unique extension identifier (lowercase, kebab-case) */
  id: string;
  /** Display name */
  name: string;
  /** Semantic version (e.g., "1.0.0") */
  version: string;
  /** Entry points for different contexts */
  entries: {
    /** Path to frontend entry file (relative to zip root) */
    frontend?: string;
    /** Path to view entry file (relative to zip root) */
    view?: string;
  };
  /** Optional custom routes exposed by this extension */
  routes?: Array<{
    /** Route path (e.g., "dashboard") */
    path: string;
    /** Display title */
    title?: string;
    /** Optional route description */
    description?: string;
    /** Optional sidebar menu item */
    menuItem?: {
      /** Sidebar title */
      title: string;
      /**
       * Icon can be either inline SVG markup or a path to an SVG file
       * inside the extension package (e.g., "assets/icon.svg").
       */
      icon?: string;
    };
  }>;
  /** Optional description */
  description?: string;
  /** Optional author info */
  author?: string;
};

function isLikelyInlineSvg(value: string): boolean {
  return value.trim().startsWith("<svg");
}

function isValidSvgAssetPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().endsWith(".svg")) {
    return false;
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return false;
  }
  if (trimmed.includes("..")) {
    return false;
  }
  return true;
}

export function validateManifest(data: unknown): ExtensionManifest {
  if (!data || typeof data !== "object") {
    throw new Error("Manifest must be an object");
  }

  const manifest = data as Record<string, unknown>;

  if (typeof manifest.id !== "string" || !manifest.id) {
    throw new Error("Manifest 'id' is required and must be a string");
  }

  if (!/^[a-z0-9-]+$/.test(manifest.id)) {
    throw new Error("Manifest 'id' must be lowercase alphanumeric with hyphens only");
  }

  if (typeof manifest.name !== "string" || !manifest.name) {
    throw new Error("Manifest 'name' is required and must be a string");
  }

  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("Manifest 'version' is required and must be a string");
  }

  if (!manifest.entries || typeof manifest.entries !== "object") {
    throw new Error("Manifest 'entries' is required and must be an object");
  }

  const entries = manifest.entries as Record<string, unknown>;

  if (entries.frontend !== undefined && typeof entries.frontend !== "string") {
    throw new Error("Manifest 'entries.frontend' must be a string");
  }
  if (entries.view !== undefined && typeof entries.view !== "string") {
    throw new Error("Manifest 'entries.view' must be a string");
  }

  let routes: ExtensionManifest["routes"] | undefined = undefined;
  if (manifest.routes !== undefined) {
    if (!Array.isArray(manifest.routes)) {
      throw new Error("Manifest 'routes' must be an array");
    }

    routes = manifest.routes.map((route, index) => {
      if (!route || typeof route !== "object") {
        throw new Error(`Manifest 'routes[${index}]' must be an object`);
      }

      const routeObj = route as Record<string, unknown>;
      if (typeof routeObj.path !== "string" || !routeObj.path) {
        throw new Error(`Manifest 'routes[${index}].path' is required`);
      }

      let menuItem: { title: string; icon?: string } | undefined = undefined;
      if (routeObj.menuItem !== undefined) {
        if (!routeObj.menuItem || typeof routeObj.menuItem !== "object") {
          throw new Error(`Manifest 'routes[${index}].menuItem' must be an object`);
        }
        const menuItemObj = routeObj.menuItem as Record<string, unknown>;
        if (typeof menuItemObj.title !== "string" || !menuItemObj.title) {
          throw new Error(
            `Manifest 'routes[${index}].menuItem.title' is required`,
          );
        }
        if (menuItemObj.icon !== undefined) {
          if (typeof menuItemObj.icon !== "string") {
            throw new Error(`Manifest 'routes[${index}].menuItem.icon' must be a string`);
          }
          if (
            !isLikelyInlineSvg(menuItemObj.icon) &&
            !isValidSvgAssetPath(menuItemObj.icon)
          ) {
            throw new Error(
              `Manifest 'routes[${index}].menuItem.icon' must be inline SVG markup or a relative .svg file path`,
            );
          }
        }
        menuItem = {
          title: menuItemObj.title,
          icon: menuItemObj.icon as string | undefined,
        };
      }

      return {
        path: routeObj.path,
        title: typeof routeObj.title === "string" ? routeObj.title : undefined,
        description:
          typeof routeObj.description === "string" ? routeObj.description : undefined,
        menuItem,
      };
    });
  }

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    entries: {
      frontend: entries.frontend as string | undefined,
      view: entries.view as string | undefined,
    },
    routes,
    description:
      typeof manifest.description === "string" ? manifest.description : undefined,
    author: typeof manifest.author === "string" ? manifest.author : undefined,
  };
}
