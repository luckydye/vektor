import { type Accessor, createSignal } from "solid-js";
import { getSession } from "#composeables/auth-client.ts";
import { config, LOCAL_USER } from "#config";

type UserProfile = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null | undefined;
};

// Browser islands share the session profile. SSR must not retain either the
// authenticated user or an in-flight session lookup in the server module graph.
const [browserUser, setBrowserUser] = createSignal<UserProfile>();
let browserLoading = false;

async function loadUserSession(): Promise<void> {
  if (config().NO_AUTH === "1") {
    setBrowserUser(LOCAL_USER);
    return;
  }

  try {
    const { data: session } = await getSession();
    setBrowserUser(session?.user);
  } catch (error) {
    console.error("Failed to load user session:", error);
    setBrowserUser(undefined);
  }
}

export function useUserProfile(): Accessor<UserProfile | undefined> {
  // An empty accessor on the server, not the shared one: the module-level
  // signal is a browser cache, and a server render must never retain a user.
  if (typeof window === "undefined") return () => undefined;

  // A plain boolean rather than a signal — nothing reads it reactively, it only
  // stops a second island kicking off the same session lookup.
  if (!browserLoading) {
    browserLoading = true;
    void loadUserSession();
  }

  return browserUser;
}
