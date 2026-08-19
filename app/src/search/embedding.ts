/**
 * Turning document text into an embedding vector, and back.
 *
 * No database access: callers read and write the stored columns themselves.
 */

import type { DocumentPropertyValue } from "#documents/properties.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { embedTexts, getEmbeddingModel } from "#search/embeddingRuntime.ts";
import { normalizeText, stripMarkup } from "#search/text.ts";

export function buildDocumentSearchText(
  content: string,
  properties: Record<string, DocumentPropertyValue>,
  fileText?: string,
): string {
  const titleValue = properties.title;
  const title = titleValue ? propertyValueToText(titleValue).trim() : "";
  const propertyText = Object.entries(properties)
    .map(([key, value]) => `${key}: ${propertyValueToText(value)}`)
    .join("\n");

  return [title, title, propertyText, content, fileText].filter(Boolean).join("\n\n");
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  if (!embedding) {
    throw new Error("Native embedding runtime returned no vector");
  }
  return embedding;
}

export function parseEmbedding(value: string | null | undefined): number[] | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => Number(item) || 0) : null;
  } catch {
    return null;
  }
}

export function serializeEmbedding(embedding: number[]): string {
  return JSON.stringify(embedding);
}
