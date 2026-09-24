import { type Accessor, createMemo, createSignal } from "solid-js";
import { api, type CurrentUser, type InstanceUser } from "#api/client.ts";
import { useQuery } from "./query.ts";
import { useCursorPagedList } from "./useCursorPagedList.ts";

/** One page of the register, the size the other admin tables here page by. */
const REGISTER_PAGE_SIZE = 50;

/**
 * The instance's user register, and whether the caller may see it at all.
 *
 * Both answers come from the server: `users/me` says who administers the
 * instance, and the register is what `/users` answers unscoped — an empty page
 * for anyone else, so the query stays disabled rather than the view rendering
 * that emptiness as an instance with nobody in it. `active` keeps it from being
 * read until the tab showing it is open.
 *
 * A pager rather than a load-more list: this is a table an admin scans, and the
 * register has no total to count against, so one page at a time with `Previous`
 * and `Next` is what {@link useCursorPagedList} is for.
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

  // An empty page and a page not yet asked for look identical from the outside —
  // both are no rows — so the one fetch that has come back is what tells them
  // apart, and the view shows a skeleton until it has.
  const [hasAnswered, setHasAnswered] = createSignal(false);

  const paged = useCursorPagedList<InstanceUser>({
    queryKey: ["instance_users"],
    fetcher: async ({ limit, cursor }) => {
      const page = await api.users.all({ limit, cursor });
      setHasAnswered(true);
      return { items: page.users, nextCursor: page.nextCursor };
    },
    enabled: createMemo(() => isInstanceAdmin() === true && active()),
    pageSize: REGISTER_PAGE_SIZE,
  });

  const error = createMemo(() => paged.error()?.message ?? null);

  return {
    isInstanceAdmin,
    users: paged.items,
    // A failure is reported rather than waited on, which is why the error is
    // read here too: it is the other way this stops being unknown.
    isLoading: createMemo(() => paged.isLoading() || (!hasAnswered() && !error())),
    isFetching: paged.isFetching,
    error,
    hasPrevPage: paged.hasPrevPage,
    hasNextPage: paged.hasNextPage,
    nextPage: paged.nextPage,
    prevPage: paged.prevPage,
  };
}
