import type { ApiRouteModule } from "./types.ts";

export interface CompiledRoute {
  regex: RegExp;
  paramNames: string[];
  /** True when the route ends in a catch-all (`[...name]`) segment. */
  hasCatchAll: boolean;
  /** Per-segment specificity score, used for ordering (literal > param > rest). */
  specificity: number[];
  module: ApiRouteModule;
  pattern: string;
}

const SEGMENT_LITERAL = 2;
const SEGMENT_PARAM = 1;
const SEGMENT_REST = 0;

/** Compile an Astro-style pattern (e.g. `/api/v1/spaces/[spaceId]`) into a matcher. */
export function compileRoute(pattern: string, module: ApiRouteModule): CompiledRoute {
  const segments = pattern.split("/").filter((s) => s.length > 0);
  const paramNames: string[] = [];
  const specificity: number[] = [];
  let hasCatchAll = false;
  let regexBody = "";

  for (const segment of segments) {
    const restMatch = segment.match(/^\[\.\.\.(.+)\]$/);
    if (restMatch) {
      paramNames.push(restMatch[1]);
      hasCatchAll = true;
      specificity.push(SEGMENT_REST);
      // Catch-all: match the remaining path (one or more segments).
      regexBody += "/(.+)";
      continue;
    }

    const paramMatch = segment.match(/^\[(.+)\]$/);
    if (paramMatch) {
      paramNames.push(paramMatch[1]);
      specificity.push(SEGMENT_PARAM);
      regexBody += "/([^/]+)";
      continue;
    }

    specificity.push(SEGMENT_LITERAL);
    regexBody += "/" + segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const regex = new RegExp(`^${regexBody || "/"}/?$`);
  return { regex, paramNames, hasCatchAll, specificity, module, pattern };
}

/**
 * Sort routes so the most specific match wins: longer paths first, then
 * literal segments before params before catch-alls.
 */
export function sortRoutes(routes: CompiledRoute[]): CompiledRoute[] {
  return [...routes].sort((a, b) => {
    const len = Math.max(a.specificity.length, b.specificity.length);
    for (let i = 0; i < len; i++) {
      const sa = a.specificity[i] ?? -1;
      const sb = b.specificity[i] ?? -1;
      if (sa !== sb) return sb - sa;
    }
    return 0;
  });
}

export interface RouteMatch {
  module: ApiRouteModule;
  params: Record<string, string | undefined>;
}

/** Find the first route whose pattern matches `pathname`, extracting params. */
export function matchRoute(routes: CompiledRoute[], pathname: string): RouteMatch | null {
  for (const route of routes) {
    const match = route.regex.exec(pathname);
    if (!match) continue;

    const params: Record<string, string | undefined> = {};
    route.paramNames.forEach((name, index) => {
      const raw = match[index + 1];
      try {
        params[name] = raw === undefined ? undefined : decodeURIComponent(raw);
      } catch {
        params[name] = raw;
      }
    });

    return { module: route.module, params };
  }

  return null;
}
