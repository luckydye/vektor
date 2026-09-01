/**
 * Conditional requests: entity tags in, 304 and 412 out.
 *
 * The semantics are HTTP's and, for writes, the ones an object store already
 * gives a conditional `PUT` — see `PutCondition` in `#files/storage.ts`, which
 * this mirrors at the document level. A caller reads a document with its tag,
 * decides something, then writes back naming the tag it decided from; if the
 * document moved in between, the write is refused rather than silently applied
 * over someone else's.
 *
 * The tag is opaque to callers. Only this module knows how one is spelled, so
 * that changing the encoding stays a change to one file.
 */

import { jsonResponse } from "#api/http.ts";

/**
 * The entity tag for a document at a given sequence.
 *
 * Strong, because `If-Match` will be compared against it and a weak tag can
 * never satisfy `If-Match`.
 */
export function documentEtag(changeSeq: number): string {
  return `"${changeSeq}"`;
}

/**
 * The entity tag for one stored revision.
 *
 * A revision's content cannot change, so this is derived from the revision
 * number rather than the document's sequence — and deliberately in a different
 * shape, because `?rev=3` and the canonical read of the same document are
 * different representations at one URL. Sharing a tag between them is how a
 * cache is talked into answering one with the other.
 */
export function revisionEtag(rev: number): string {
  return `"rev-${rev}"`;
}

/**
 * Whether `header` names `etag`, ignoring strength.
 *
 * The comparison `If-None-Match` requires: a cache is allowed to weaken a tag it
 * stored, so `W/"x"` and `"x"` are the same entity here. Answering 304 says
 * nothing changed, which stays true either way.
 */
export function matchesWeak(header: string, etag: string): boolean {
  const strip = (value: string) => value.trim().replace(/^W\//, "");
  if (header.trim() === "*") return true;
  return header.split(",").some((candidate) => strip(candidate) === strip(etag));
}

/**
 * The sequences an `If-Match` header would accept.
 *
 * `"any"` for `*`, which asks only that the document exist. Otherwise every tag
 * the header names, decoded — a list, because `If-Match` states "any of these"
 * and a single write can express that where a loop of writes cannot.
 *
 * This is also where `If-Match` gets its strong comparison. The pattern admits
 * a strong document tag and nothing else, so a weak one never authorizes a
 * write: `W/"5"` promises only that two representations are equivalent, never
 * that they are the same bytes, which is not enough to overwrite on. A tag this
 * server could not have issued — a weak one, another origin's, a revision tag
 * on a write — is simply absent from the list, and a header made entirely of
 * those yields an empty list that no document can satisfy. Which is the right
 * answer: the caller is naming a state this document was never in.
 */
export function expectedSeqs(header: string): number[] | "any" {
  if (header.trim() === "*") return "any";
  return header
    .split(",")
    .map((candidate) => /^"(\d+)"$/.exec(candidate.trim())?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number);
}

/**
 * Cache directive for anything the ACL gates.
 *
 * `private` keeps a shared cache from holding a body one user was authorized
 * for and handing it to the next; `must-revalidate` keeps a browser from
 * serving it after access has been taken away.
 */
export const PRIVATE_REVALIDATE = "private, must-revalidate";

/**
 * `vary` repeats what the 200 would have carried: a cache that does not know
 * what the body was negotiated by cannot safely reuse the entry this refreshes.
 */
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

/**
 * The condition named a state the document is no longer in.
 *
 * The body carries the document as it stands now, and the header its current
 * tag, so a caller can reconcile and retry without a second round trip — which
 * matters most to the writer that is furthest away.
 */
export function preconditionFailed(current: unknown, etag: string): Response {
  return jsonResponse(
    { error: "Document has changed", document: current },
    412,
    { ETag: etag },
  );
}
