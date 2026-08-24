import { createHash } from "node:crypto";
import { config } from "#config";

// Covers the largest avatar we render (64px) on a 3x display.
const gravatarSize = 256;

/**
 * Base URL of the Gravatar-compatible service to consult, or null when the
 * operator has not configured one and profile pictures stay local.
 *
 * A malformed or non-HTTP value disables the lookup rather than emitting a
 * broken URL, and does so silently: a typo in `VEKTOR_GRAVATAR_URL` shows up as
 * avatars staying local, not as a log line.
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
    // Not a URL at all — same outcome as a non-HTTP one.
  }

  return null;
}

/**
 * MD5, not the SHA-256 gravatar.com now prefers: it is the one hash every
 * Gravatar-compatible service keys on, and self-hosted ones commonly accept
 * nothing else.
 *
 * `d=404` makes the service refuse rather than serve one of its own default
 * images for an address with no account, which is what lets the client fall
 * back to the id-seeded generated face.
 */
function gravatarUrl(host: string, email: string): string {
  const hash = createHash("md5").update(email.trim().toLowerCase()).digest("hex");
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
