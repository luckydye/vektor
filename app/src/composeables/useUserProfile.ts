import { ref } from "vue";
import { getSession } from "../composeables/auth-client.ts";
import { config } from "../config.ts";
import { LOCAL_USER } from "../noAuth.ts";

type UserProfile = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null | undefined;
};

// Browser islands share the resolved profile. SSR must not retain either the
// authenticated user or an in-flight session lookup in the server module graph.
const browserLoading = ref(false);
const browserUser = ref<UserProfile>();

async function loadUserSession(user: typeof browserUser) {
  if (config().NO_AUTH === "1") {
    user.value = LOCAL_USER;
    return;
  }

  try {
    const { data: session } = await getSession();
    user.value = session?.user;
  } catch (error) {
    console.error("Failed to load user session:", error);
    user.value = undefined;
  }
}

export function useUserProfile() {
  if (typeof window === "undefined") {
    return ref<UserProfile>();
  }

  if (!browserLoading.value) {
    browserLoading.value = true;
    void loadUserSession(browserUser);
  }

  return browserUser;
}
