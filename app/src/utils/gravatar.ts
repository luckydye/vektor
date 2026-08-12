import { createHash } from "node:crypto";
import { config } from "#config";
import { appLogger } from "#observability/logger.ts";

// Covers the largest avatar we render (64px) on a 3x display.
const gravatarSize = 256;

let warnedInvalidHost = false;

/**
 * Base URL of the Gravatar-compatible service to consult, or null when the
 * operator has not configured one and profile pictures stay local. A malformed
 * or non-HTTP value disables the lookup rather than emitting a broken URL.
 */
function gravatarHost(): string | null {
  const raw = config().GRAVATAR_URL?.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.href.replace(/\/+$/, "");
    }
  } catch {
    // Fall through to the warning below.
  }

  if (!warnedInvalidHost) {
    warnedInvalidHost = true;
    appLogger.warn(
      "VEKTOR_GRAVATAR_URL is not a valid http(s) URL; avatar lookups are disabled",
      { value: raw },
    );
  }
  return null;
}

/**
 * `d=404` makes the service refuse rather than serve one of its own default
 * images for an address with no account, which is what lets the client fall
 * back to the id-seeded generated face.
 */
function gravatarUrl(host: string, email: string): string {
  const hash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return `${host}/avatar/${hash}?d=404&s=${gravatarSize}`;
}

/**
 * The `image` to publish for a user: the picture their login provider supplied,
 * else a Gravatar URL when a host is configured. null means the client draws the
 * generated avatar itself.
 */
export function resolveProfileImage(user: {
  email?: string | null;
  image?: string | null;
}): string | null {
  if (user.image) return user.image;
  if (!user.email) return null;

  const host = gravatarHost();
  return host ? gravatarUrl(host, user.email) : null;
}
