import { AsyncLocalStorage } from "node:async_hooks";
import { setLangResolver } from "./lang.ts";

/**
 * Request-scoped locale for server rendering.
 *
 * Server only — the `node:async_hooks` import is why this is a separate module
 * from `lang.ts`, which is bundled for the browser too.
 *
 * `AsyncLocalStorage` rather than a module-level variable because renders
 * interleave: Astro's page pipeline awaits, so a second request begins while
 * the first is still rendering, and a shared variable produced 26 wrong-locale
 * renders out of 60 when this was measured. Storage keyed to the async context
 * gives each request its own value with no framework involved, which is the
 * point — the previous mechanism was Vue's `inject`.
 */
const storage = new AsyncLocalStorage<string>();

setLangResolver(() => storage.getStore());

/** Runs `fn` with `lang` as the ambient locale for everything it awaits. */
export function runWithLang<T>(lang: string | undefined, fn: () => T): T {
  return lang ? storage.run(lang, fn) : fn();
}
