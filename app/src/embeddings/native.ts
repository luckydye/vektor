import type * as NativeEmbedding from "#native/embedding/index.d.ts";
import { getNativeAddonExport } from "#utils/nativeAddon.ts";

export type NativeEmbeddingAddon = typeof NativeEmbedding;

const EMBEDDED_MODEL_ID =
  "Qdrant/bge-small-en-v1.5-onnx-Q@c32e6154d1bb7a0e47c5e745fd895e7700f44385";

let addon: NativeEmbeddingAddon | undefined;

async function getNativeEmbedding(): Promise<NativeEmbeddingAddon> {
  if (addon) return addon;

  try {
    // build.ts generates the shim's static .node require so Bun embeds the
    // addon. Native import() preserves the named ESM binding in compiled
    // binaries while keeping addon loading lazy.
    const nativeModule: unknown = await import("./native/addon.ts");
    addon = getNativeAddonExport<NativeEmbeddingAddon>(nativeModule, {
      addonName: "embedding",
      exportName: "nativeEmbedding",
      requiredFunction: "embed",
      moduleUrl: import.meta.url,
    });
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

  return (await getNativeEmbedding()).embed(texts);
}

export function getEmbeddingModel(): string {
  return EMBEDDED_MODEL_ID;
}
