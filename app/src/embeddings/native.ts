import type * as NativeEmbedding from "#native/embedding/index.d.ts";

export type NativeEmbeddingAddon = typeof NativeEmbedding;

const EMBEDDED_MODEL_ID =
  "Qdrant/bge-small-en-v1.5-onnx-Q@c32e6154d1bb7a0e47c5e745fd895e7700f44385";

let addon: NativeEmbeddingAddon | undefined;

function getNativeEmbedding(): NativeEmbeddingAddon {
  if (addon) return addon;

  try {
    // build.ts generates this static require so Bun embeds the .node addon.
    // biome-ignore lint/suspicious/noExplicitAny: generated native module
    addon = (require("./native/addon") as any).default as NativeEmbeddingAddon;
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
