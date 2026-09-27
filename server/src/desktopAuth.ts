import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { constantTimeEqual, generateRandomString } from "better-auth/crypto";

/**
 * Hands a browser sign-in over to the desktop app, which cannot run OAuth in
 * its webview (Google refuses embedded browsers).
 *
 * PKCE-shaped: the app keeps a secret verifier and sends only its SHA-256
 * `challenge` to the browser. The browser trades its session for a one-time
 * code delivered through the app's URL scheme, and the app's webview redeems
 * code plus verifier for a session of its own. Whatever else intercepts the
 * scheme URL holds the code but not the verifier.
 */

const CODE_TTL_MS = 2 * 60 * 1000;
const HEX_64 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Za-z0-9]{32}$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export const desktopAuth = () =>
  ({
    id: "desktop-auth",
    endpoints: {
      startDesktopHandoff: createAuthEndpoint(
        "/desktop-handoff/start",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const challenge = (ctx.body as { challenge?: unknown } | undefined)?.challenge;
          if (typeof challenge !== "string" || !HEX_64.test(challenge)) {
            throw new APIError("BAD_REQUEST", { message: "Invalid challenge" });
          }
          const code = generateRandomString(32, "a-z", "A-Z", "0-9");
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: `desktop-handoff:${code}`,
            value: JSON.stringify({ userId: ctx.context.session.user.id, challenge }),
            expiresAt: new Date(Date.now() + CODE_TTL_MS),
          });
          return ctx.json({ code });
        },
      ),

      completeDesktopHandoff: createAuthEndpoint(
        "/desktop-handoff/complete",
        { method: "GET" },
        async (ctx) => {
          const { code, verifier } = (ctx.query ?? {}) as Record<string, unknown>;
          if (
            typeof code !== "string" ||
            !CODE.test(code) ||
            typeof verifier !== "string" ||
            !HEX_64.test(verifier)
          ) {
            throw new APIError("BAD_REQUEST", { message: "Invalid sign-in link" });
          }
          // Consumed before anything is checked, so a wrong verifier burns the code too.
          const stored = await ctx.context.internalAdapter.consumeVerificationValue(
            `desktop-handoff:${code}`,
          );
          if (!stored || stored.expiresAt < new Date()) {
            throw new APIError("UNAUTHORIZED", { message: "Sign-in link expired" });
          }
          const { userId, challenge } = JSON.parse(stored.value) as {
            userId: string;
            challenge: string;
          };
          if (!constantTimeEqual(await sha256Hex(verifier), challenge)) {
            throw new APIError("UNAUTHORIZED", { message: "Invalid sign-in link" });
          }
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) {
            throw new APIError("UNAUTHORIZED", { message: "User not found" });
          }
          // A session of the app's own: signing out in the browser leaves it alone.
          const session = await ctx.context.internalAdapter.createSession(userId);
          await setSessionCookie(ctx, { session, user });
          throw ctx.redirect("/");
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
