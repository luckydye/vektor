import type { LoginTarget } from "#peerFederation";
import { authClient } from "./auth-client.ts";

export type { LoginTarget };

/** Asks this instance whether the email signs in here or on a peer. */
export async function resolveLoginTarget(email: string): Promise<LoginTarget> {
  const response = await fetch("/api/auth/federation/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) {
    const data = (await response.json()) as { message?: string };
    throw new Error(data.message ?? `Login lookup failed with ${response.status}`);
  }
  return (await response.json()) as LoginTarget;
}

export function signInWithPeer(providerId: string, email: string, callbackURL: string) {
  return authClient.signIn.oauth2({
    providerId,
    callbackURL,
    errorCallbackURL: "/error",
    newUserCallbackURL: callbackURL,
    additionalData: { loginHint: email },
  });
}
