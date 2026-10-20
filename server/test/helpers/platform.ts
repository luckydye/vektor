import { createBunPlatform } from "#platform/bun/index.ts";

/**
 * The platform specs hand to the server modules they call in-process. One for the
 * run, because the server project shares modules across files (`isolate: false`).
 */
export const platform = createBunPlatform();
