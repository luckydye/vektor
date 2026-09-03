/** Conditional requests: entity tags in, 304 and 412 out. */

import { jsonResponse } from "#api/http.ts";

export function documentEtag(changeSeq: number): string {
  return `"${changeSeq}"`;
}

export function revisionEtag(rev: number): string {
  return `"rev-${rev}"`;
}

/** Weak comparison, as `If-None-Match` requires. */
export function matchesWeak(header: string, etag: string): boolean {
  const strip = (value: string) => value.trim().replace(/^W\//, "");
  if (header.trim() === "*") return true;
  return header.split(",").some((candidate) => strip(candidate) === strip(etag));
}

/**
 * The sequences an `If-Match` would accept, or `"any"` for `*`.
 *
 * The pattern admits a strong document tag and nothing else, so a weak tag
 * decodes to nothing and never authorizes a write.
 */
export function expectedSeqs(header: string): number[] | "any" {
  if (header.trim() === "*") return "any";
  return header
    .split(",")
    .map((candidate) => /^"(\d+)"$/.exec(candidate.trim())?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number);
}

/** For anything the ACL gates. */
export const PRIVATE_REVALIDATE = "private, must-revalidate";

export function notModified(etag: string, vary?: string): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
      "Cache-Control": PRIVATE_REVALIDATE,
      ...(vary ? { Vary: vary } : {}),
    },
  });
}

/** 412 with the document as it now stands. */
export function preconditionFailed(current: unknown, etag: string): Response {
  return jsonResponse({ error: "Document has changed", document: current }, 412, {
    ETag: etag,
  });
}
