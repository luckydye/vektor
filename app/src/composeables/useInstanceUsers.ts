import { type Accessor, createMemo } from "solid-js";
import { api, type CurrentUser, type InstanceUser } from "#api/client.ts";
import { useQuery } from "./query.ts";

/**
 * How many accounts the register asks for. The server caps one answer anyway;
 * naming the page here is what lets the view say it is showing a page rather
 * than quietly presenting the newest few hundred accounts as the whole instance.
 */
export const REGISTER_PAGE_SIZE = 500;

/**
 * The instance's user register, and whether the caller may see it at all.
 *
 * Both answers come from the server: `users/me` says who administers the
 * instance, and the register is what `/users` answers unscoped — empty for
 * anyone else, so the query stays disabled rather than the page rendering that
 * emptiness as an instance with nobody in it. `active` keeps it from being read
 * until the tab showing it is open.
 */
export function useInstanceUsers(active: Accessor<boolean>) {
  // The same key `useSpace` reads, so asking here costs no extra request.
  const { data: currentUser, error: currentUserError } = useQuery<CurrentUser>({
    queryKey: ["current_user"],
    queryFn: () => api.users.me(),
  });

  // Undefined until the answer arrives, so a caller can tell "not an admin"
  // from "not known yet" and neither flash nor pre-render the tab.
  const isInstanceAdmin = createMemo(() => {
    const answered = currentUser()?.isAdmin;
    if (answered !== undefined) return answered;
    // A request that failed is an answer too — not an admin. Left undefined, a
    // linked `?tab=users` would wait on a reply that is not coming: the register
    // query never becomes enabled, so the page holds its skeleton forever.
    return currentUserError() ? false : undefined;
  });

  const {
    data: users,
    isLoading,
    error,
  } = useQuery<InstanceUser[]>({
    queryKey: ["instance_users", REGISTER_PAGE_SIZE],
    queryFn: () => api.users.all({ limit: REGISTER_PAGE_SIZE }),
    enabled: createMemo(() => isInstanceAdmin() === true && active()),
  });

  return {
    isInstanceAdmin,
    users,
    isLoading,
    // A full page is as much as this asked for, so there may be more accounts
    // behind it — true as well when the instance holds exactly that many, which
    // is why the view says what it is showing rather than what it is missing.
    capped: createMemo(() => (users()?.length ?? 0) >= REGISTER_PAGE_SIZE),
    error: createMemo(() => error()?.message ?? null),
  };
}
