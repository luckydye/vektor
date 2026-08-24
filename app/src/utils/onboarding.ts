/**
 * Which one-off introductions this browser has already shown.
 *
 * Client-only like a pinned space: it describes this reader, not the space, so it
 * never reaches the API.
 */
import { readStored, writeStored } from "./clientStorage.ts";

/** Exported for `scripts/record-onboarding.ts`, which suppresses the tour it films. */
export const ORGANIZATION_TOUR_KEY = "onboarding-document-organization";

/**
 * Whether the document-organization tour has run.
 *
 * Answers "seen" on the server and before mount, because guessing the other way
 * renders the dialog into the SSR markup and flashes it on every load.
 */
export function hasSeenOrganizationTour(): boolean {
  if (typeof window === "undefined") return true;
  return readStored<boolean>(ORGANIZATION_TOUR_KEY) === true;
}

export function markOrganizationTourSeen(): void {
  writeStored(ORGANIZATION_TOUR_KEY, true);
}
