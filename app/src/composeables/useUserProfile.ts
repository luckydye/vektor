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

const collaborationColors = [
  "#FF6B6B",
  "#4ECDC4",
  "#45B7D1",
  "#96CEB4",
  "#FFEAA7",
  "#DDA0DD",
  "#98D8C8",
  "#F7DC6F",
  "#BB8FCE",
  "#85C1E9",
  "#F8C471",
  "#82E0AA",
  "#F1948A",
  "#85C1E9",
  "#D7BDE2",
];

export const getUserColor = (userName: string) => {
  if (!userName) return collaborationColors[0];

  let hash = 0;
  for (let i = 0; i < userName.length; i++) {
    hash = userName.charCodeAt(i) + ((hash << 5) - hash);
  }

  const colorIndex = Math.abs(hash) % collaborationColors.length;
  return collaborationColors[colorIndex];
};

export function useUserProfile() {
  if (!loading.value) {
    loading.value = true;
    loadUserSession();
  }

  return user;
}
