/**
 * The Rust addons, loaded on first use. Bun embeds an N-API addon only when the
 * generated shim requires the `.node` file directly, so each shim is imported
 * by a literal path and wrapped with the diagnostics below.
 */

import type * as NativeEmbedding from "#native/embedding/index.d.ts";
import type * as NativeExec from "#native/exec/index.d.ts";
import type * as NativeImage from "#native/image/generated/index.d.ts";
import { appLogger } from "#observability/logger.ts";

export type NativeImageAddon = typeof NativeImage;
export type NativeExecAddon = typeof NativeExec;
export type NativeEmbeddingAddon = typeof NativeEmbedding;

function valueType(value: unknown): string {
  return value === null ? "null" : typeof value;
}

function ownPropertyNames(value: unknown): string[] {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return [];
  }

  try {
    return Object.getOwnPropertyNames(value).sort();
  } catch {
    return ["<unavailable>"];
  }
}

function readProperty(value: unknown, property: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }

  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function checkedAddon<T>(
  nativeModule: unknown,
  addonName: string,
  requiredFunction: string,
): T {
  const required = readProperty(nativeModule, requiredFunction);

  if (typeof required !== "function") {
    throw new TypeError(
      `Native ${addonName} addon does not expose ${requiredFunction}()`,
      {
        cause: {
          platform: process.platform,
          architecture: process.arch,
          bunVersion: process.versions.bun,
          napiVersion: process.versions.napi,
          compiled: import.meta.url.startsWith("file:///$bunfs/"),
          moduleUrl: import.meta.url,
          requiredFunction,
          moduleType: valueType(nativeModule),
          moduleProperties: ownPropertyNames(nativeModule),
          moduleRequiredFunctionType: valueType(required),
        },
      },
    );
  }

  return nativeModule as T;
}

/** One load shared by concurrent callers; a failed load is retried on the next call. */
function lazyAddon<T>(
  load: () => Promise<unknown>,
  addonName: string,
  requiredFunction: string,
): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () => {
    loading ??= load()
      .then((nativeModule) => checkedAddon<T>(nativeModule, addonName, requiredFunction))
      .catch((error: unknown) => {
        loading = undefined;
        const detail = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(`Native ${addonName} runtime unavailable${detail}`, {
          cause: error,
        });
      });
    return loading;
  };
}

export const getNativeExec = lazyAddon<NativeExecAddon>(
  () => import("#exec/native/addon.ts"),
  "JavaScript",
  "evalJsSync",
);

export const getNativeEmbedding = lazyAddon<NativeEmbeddingAddon>(
  () => import("#search/native/addon.ts"),
  "embedding",
  "embed",
);

const loadNativeImage = lazyAddon<NativeImageAddon>(
  () => import("#files/native/addon.ts"),
  "image",
  "transform",
);

let nativeImage: Promise<NativeImageAddon | null> | undefined;

/** Null, once and for good, when the addon cannot load: images then go untransformed. */
export function getNativeImage(): Promise<NativeImageAddon | null> {
  nativeImage ??= loadNativeImage().catch((error: unknown) => {
    appLogger.warn("[native] image addon unavailable — image transforms disabled", {
      error,
    });
    return null;
  });
  return nativeImage;
}
