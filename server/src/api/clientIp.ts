import { isTrustProxyEnabled } from "#config";

/**
 * The address a request is counted against.
 *
 * `X-Forwarded-For` is only believed behind a proxy the operator has vouched
 * for, and only its last entry — everything before that is whatever the client
 * chose to send, so trusting it would hand any caller an unlimited supply of
 * fresh rate-limit windows.
 */
export function resolveClientIp(
  socketIp: string | null | undefined,
  forwardedFor: string | null | undefined,
): string {
  const socket = socketIp ?? "";
  if (!isTrustProxyEnabled()) return socket;
  return forwardedFor?.split(",").at(-1)?.trim() || socket;
}
