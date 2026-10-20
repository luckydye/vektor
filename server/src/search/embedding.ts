/**
 * Turning document text into an embedding vector, and back.
 *
 * No database access: callers read and write the stored columns themselves.
 */

import type { DocumentProperties } from "#documents/properties.ts";
import { propertyValueToText } from "#documents/properties.ts";
import type { Platform } from "#platform/platform.ts";
import { normalizeText, stripMarkup } from "#search/text.ts";

export function buildDocumentSearchText(
  content: string,
  properties: DocumentProperties,
  fileText?: string,
): string {
  const titleValue = properties.title;
  const title = titleValue ? propertyValueToText(titleValue).trim() : "";
  const propertyText = Object.entries(properties)
    .map(([key, value]) => `${key}: ${propertyValueToText(value)}`)
    .join("\n");

  return [title, title, propertyText, content, fileText].filter(Boolean).join("\n\n");
}

export async function embedText(platform: Platform, text: string): Promise<number[]> {
  const [embedding] = await platform.embedder.embed([text]);
  if (!embedding) {
    throw new Error("The embedder returned no vector");
  }
  return embedding;
}

/**
 * The vector a search query is compared against documents by, or null when the
 * embedding runtime is unavailable — search then falls back to keyword matching
 * rather than failing.
 */
export async function embedSearchQuery(
  platform: Platform,
  query: string,
): Promise<number[] | null> {
  try {
    return await embedText(platform, query.trim());
  } catch {
    return null;
  }
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
