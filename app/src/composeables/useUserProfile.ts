import { ref } from "vue";
import { authClient } from "../composeables/auth-client.ts";
import { config } from "../config.ts";
import { LOCAL_USER } from "../noAuth.ts";

const loading = ref(false);
const user = ref<{
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null | undefined;
}>();

async function loadUserSession() {
  if (config().NO_AUTH === "1") {
    user.value = LOCAL_USER;
    return;
  }

  try {
    const { data: session } = await authClient.getSession();
    user.value = session?.user;
  } catch (error) {
    console.error("Failed to load user session:", error);
    user.value = undefined;
  }
}

export function useUserProfile() {
  if (!loading.value) {
    loading.value = true;
    loadUserSession();
  }

  return user;
}
