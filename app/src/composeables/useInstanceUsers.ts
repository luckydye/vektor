import { type Accessor, createMemo } from "solid-js";
import { api, type CurrentUser, type InstanceUser } from "#api/client.ts";
import { useQuery } from "./query.ts";

/**
 * The instance's user register, and whether the caller may see it at all.
 *
 * Both answers come from the server: `users/me` says who administers the
 * instance, and the register itself is admin-only, so the query stays disabled
 * for everyone else rather than the UI swallowing a 403. `active` keeps it from
 * being read until the tab showing it is open.
 */
export function useInstanceUsers(active: Accessor<boolean>) {
  // The same key `useSpace` reads, so asking here costs no extra request.
  const { data: currentUser } = useQuery<CurrentUser>({
    queryKey: ["current_user"],
    queryFn: () => api.users.me(),
  });

  // Undefined until the answer arrives, so a caller can tell "not an admin"
  // from "not known yet" and neither flash nor pre-render the tab.
  const isInstanceAdmin = createMemo(() => currentUser()?.isAdmin);

  const {
    data: users,
    isLoading,
    error,
  } = useQuery<InstanceUser[]>({
    queryKey: ["instance_users"],
    queryFn: () => api.users.directory(),
    enabled: createMemo(() => isInstanceAdmin() === true && active()),
  });

  return {
    isInstanceAdmin,
    users,
    isLoading,
    error: createMemo(() => error()?.message ?? null),
  };
}
