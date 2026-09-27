/** Text normalisation shared by indexing and ranking. */

/** Strip tags and punctuation so only words remain. */
export function stripMarkup(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase and collapse whitespace, for comparison. */
export function normalizeText(input: string): string {
  return stripMarkup(input).toLowerCase();
}
