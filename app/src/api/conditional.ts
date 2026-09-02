/**
 * Conditional requests: entity tags in, 304 and 412 out.
 *
 * The write semantics are the ones an object store gives a conditional `PUT` —
 * see `PutCondition` in `#files/storage.ts`. The tag is opaque to callers; only
 * this module knows how one is spelled.
 */

import { jsonResponse } from "#api/http.ts";

export function documentEtag(changeSeq: number): string {
  return `"${changeSeq}"`;
}

/** Derived from the revision, not the document: a revision's bytes never change. */
export function revisionEtag(rev: number): string {
  return `"rev-${rev}"`;
}

/** The `If-None-Match` comparison: a cache may weaken a tag it stored. */
export function matchesWeak(header: string, etag: string): boolean {
  const strip = (value: string) => value.trim().replace(/^W\//, "");
  if (header.trim() === "*") return true;
  return header.split(",").some((candidate) => strip(candidate) === strip(etag));
}

/**
 * The sequences an `If-Match` header would accept, or `"any"` for `*`.
 *
 * A list, because `If-Match` states "any of these". The pattern admits a strong
 * document tag and nothing else, which is where the strong comparison lives: a
 * weak tag decodes to nothing and so never authorizes a write. A header made
 * entirely of tags this server could not have issued yields an empty list,
 * which no document satisfies.
 */
export function expectedSeqs(header: string): number[] | "any" {
  if (header.trim() === "*") return "any";
  return header
    .split(",")
    .map((candidate) => /^"(\d+)"$/.exec(candidate.trim())?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number);
}

/** For anything the ACL gates: never a shared cache, never served after a revoke. */
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

/** 412 with the document as it now stands, so a caller can retry in one trip. */
export function preconditionFailed(current: unknown, etag: string): Response {
  return jsonResponse({ error: "Document has changed", document: current }, 412, {
    ETag: etag,
  });
}
