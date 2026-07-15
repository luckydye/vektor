import type * as NativeEmbedding from "#native/embedding/index.d.ts";

export type NativeEmbeddingAddon = typeof NativeEmbedding;

const EMBEDDED_MODEL_ID =
  "Qdrant/bge-small-en-v1.5-onnx-Q@c32e6154d1bb7a0e47c5e745fd895e7700f44385";

let addon: NativeEmbeddingAddon | undefined;

function valueType(value: unknown): string {
  return value === null ? "null" : typeof value;
}

function ownPropertyNames(value: unknown): string[] {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return [];
  }

  try {
    return Object.getOwnPropertyNames(value).sort();
  } catch {
    return ["<unavailable>"];
  }
}

function readProperty(value: unknown, property: string): unknown {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return undefined;
  }

  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function describeNativeModule(
  nativeModule: unknown,
  defaultExport: unknown,
): Record<string, unknown> {
  return {
    platform: process.platform,
    architecture: process.arch,
    bunVersion: process.versions.bun,
    napiVersion: process.versions.napi,
    compiled: import.meta.url.startsWith("file:///$bunfs/"),
    moduleUrl: import.meta.url,
    moduleType: valueType(nativeModule),
    moduleProperties: ownPropertyNames(nativeModule),
    moduleEmbedType: valueType(readProperty(nativeModule, "embed")),
    defaultExportType: valueType(defaultExport),
    defaultExportProperties: ownPropertyNames(defaultExport),
    defaultExportEmbedType: valueType(readProperty(defaultExport, "embed")),
  };
}

function getNativeEmbedding(): NativeEmbeddingAddon {
  if (addon) return addon;

  try {
    // build.ts generates this static require so Bun embeds the .node addon.
    const nativeModule: unknown = require("./native/addon");
    const defaultExport = readProperty(nativeModule, "default");
    if (typeof readProperty(defaultExport, "embed") !== "function") {
      throw new TypeError(
        "Native embedding addon default export does not expose embed()",
        { cause: describeNativeModule(nativeModule, defaultExport) },
      );
    }

    addon = defaultExport as NativeEmbeddingAddon;
    return addon;
  } catch (error) {
    throw new Error(
      "Native embedding runtime unavailable — run: cd native/embedding && bun run build",
      { cause: error },
    );
  }
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  return getNativeEmbedding().embed(texts);
}

export function getEmbeddingModel(): string {
  return EMBEDDED_MODEL_ID;
}
