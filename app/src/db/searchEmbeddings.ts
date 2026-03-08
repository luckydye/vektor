import { config } from "../config.ts";

const LOCAL_EMBEDDING_DIMENSIONS = 384;

function stripMarkup(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(input: string): string {
  return stripMarkup(input).toLowerCase();
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

function localEmbedding(text: string): number[] {
  const normalized = normalizeText(text);
  const vector = new Array<number>(LOCAL_EMBEDDING_DIMENSIONS).fill(0);
  const words = normalized.match(/[a-z0-9]+/g) ?? [];

  for (const word of words) {
    const wordIndex = hashToken(`w:${word}`) % LOCAL_EMBEDDING_DIMENSIONS;
    vector[wordIndex] += 3;

    if (word.length >= 3) {
      for (let index = 0; index <= word.length - 3; index++) {
        const trigram = word.slice(index, index + 3);
        const trigramIndex = hashToken(`g:${trigram}`) % LOCAL_EMBEDDING_DIMENSIONS;
        vector[trigramIndex] += 1;
      }
    }
  }

  return normalizeVector(vector);
}

async function remoteEmbedding(text: string): Promise<number[]> {
  const runtimeConfig = config();
  const apiKey = runtimeConfig.SEARCH_EMBEDDINGS_API_KEY || runtimeConfig.OPENROUTER_API_KEY;
  const model =
    runtimeConfig.SEARCH_EMBEDDINGS_MODEL || "text-embedding-3-small";
  const baseUrl =
    runtimeConfig.SEARCH_EMBEDDINGS_BASE_URL || "https://openrouter.ai/api/v1";

  if (!apiKey) {
    throw new Error("SEARCH_EMBEDDINGS_API_KEY is not configured");
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding request failed with status ${response.status}`);
  }

  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("Embedding response did not include a vector");
  }
  return normalizeVector(embedding.map((value: unknown) => Number(value) || 0));
}

export function buildDocumentSearchText(
  content: string,
  properties: Record<string, string>,
): string {
  const title = properties.title?.trim() ?? "";
  const propertyText = Object.entries(properties)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  return [title, title, propertyText, content].filter(Boolean).join("\n\n");
}

export async function embedText(text: string): Promise<number[]> {
  const provider = config().SEARCH_EMBEDDINGS_PROVIDER || "local";

  if (provider === "remote") {
    return remoteEmbedding(text);
  }

  return localEmbedding(text);
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

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let total = 0;
  for (let index = 0; index < left.length; index++) {
    total += left[index] * right[index];
  }
  return total;
}

export function extractQueryTerms(query: string): string[] {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((match) =>
    normalizeText(match[1]).trim(),
  );
  const unquoted = query.replace(/"[^"]+"/g, " ");
  const words = (normalizeText(unquoted).match(/[a-z0-9*]+/g) ?? []).map((term) =>
    term.replace(/\*+$/g, ""),
  );

  return [...new Set([...phrases, ...words].filter((term) => term.length > 0))];
}

export function scoreKeywordOverlap(query: string, text: string): number {
  const haystack = normalizeText(text);
  const terms = extractQueryTerms(query);
  if (terms.length === 0) {
    return 0;
  }

  let score = 0;
  for (const term of terms) {
    const exactIndex = haystack.indexOf(term);
    if (exactIndex >= 0) {
      score += term.includes(" ") ? 1.5 : 1;
      if (exactIndex < 80) {
        score += 0.5;
      }
      if (exactIndex === 0) {
        score += 0.5;
      }
      continue;
    }

    if (!term.includes(" ")) {
      const words = haystack.match(/[a-z0-9]+/g) ?? [];
      const prefixIndex = words.findIndex((word) => word.startsWith(term));
      if (prefixIndex >= 0) {
        score += 0.8;
        if (prefixIndex < 8) {
          score += 0.3;
        }
      }
    }
  }

  return score / terms.length;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildSearchSnippet(query: string, text: string): string {
  const normalizedText = stripMarkup(text);
  if (!normalizedText) {
    return "";
  }

  const terms = extractQueryTerms(query);
  const lowerText = normalizedText.toLowerCase();
  let startIndex = 0;

  for (const term of terms) {
    const index = lowerText.indexOf(term.toLowerCase());
    if (index >= 0) {
      startIndex = Math.max(0, index - 60);
      break;
    }
  }

  const excerpt = normalizedText.slice(startIndex, startIndex + 220).trim();
  let highlighted = escapeHtml(excerpt);

  for (const term of [...terms].sort((left, right) => right.length - left.length)) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    highlighted = highlighted.replace(
      new RegExp(escaped, "gi"),
      (match) => `<mark>${match}</mark>`,
    );
  }

  return highlighted;
}
