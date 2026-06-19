import { createAuthClient } from "better-auth/client";
import { genericOAuthClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [genericOAuthClient()],
});

// Shared promise so all callers reuse a single session fetch per page load.
let sessionPromise: ReturnType<typeof authClient.getSession> | null = null;
export function getSession() {
  if (!sessionPromise) {
    sessionPromise = authClient.getSession();
  }
  return sessionPromise;
}
