import type * as NativeEmbedding from "#native/embedding/index.d.ts";
import { getNativeAddon } from "#utils/nativeAddon.ts";

export type NativeEmbeddingAddon = typeof NativeEmbedding;

const EMBEDDED_MODEL_ID =
  "Qdrant/bge-small-en-v1.5-onnx-Q@c32e6154d1bb7a0e47c5e745fd895e7700f44385";

let addon: NativeEmbeddingAddon | undefined;
let addonPromise: Promise<NativeEmbeddingAddon> | undefined;

async function loadNativeEmbedding(): Promise<NativeEmbeddingAddon> {
  const nativeModule: unknown = await import("./native/addon.ts");
  return getNativeAddon<NativeEmbeddingAddon>(nativeModule, {
    addonName: "embedding",
    requiredFunction: "embed",
    moduleUrl: import.meta.url,
  });
}

export async function getNativeEmbedding(): Promise<NativeEmbeddingAddon> {
  if (addon) return addon;

  try {
    // Bun embeds N-API addons only when the generated shim requires the .node
    // file directly. Keep the dynamic import so loader failures can be wrapped
    // with the diagnostics below.
    addonPromise ??= loadNativeEmbedding();
    addon = await addonPromise;
    return addon;
  } catch (error) {
    addonPromise = undefined;
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
