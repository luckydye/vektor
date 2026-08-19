import { createMemo, createSignal, For, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { api, type InstanceUser } from "#api/client.ts";
import { islandQueryClient } from "#composeables/islandQueryClient.ts";
import { QueryClientContext } from "#composeables/query.ts";
import { useInstanceUsers } from "#composeables/useInstanceUsers.ts";
import { usePinnedSpaces } from "#composeables/usePinnedSpaces.ts";
import { type Space as ApiSpace, useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { formatAbsoluteDate } from "#utils/dateFormat.ts";
import { setClientLang, t } from "#utils/lang.ts";
import { MIN_SIDEBAR_WIDTH } from "#utils/sidebarState.ts";
import { CreateSpaceDialog } from "./CreateSpaceDialog.tsx";
import { DeleteSpaceDialog } from "./DeleteSpaceDialog.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { type OverviewSpace, SpacesOverview } from "./SpacesOverview.tsx";
import { ToastContainer } from "./ToastContainer.tsx";
import { UserProfile } from "./UserProfile.tsx";
import { UsersOverview } from "./UsersOverview.tsx";

/** The pages `/spaces` holds, in the order the rail lists them. */
export type SpacesTab = "spaces" | "users";

interface RailTab {
  id: SpacesTab;
  label: string;
  icon: IconName;
}

interface Props {
  replicaScope?: string;
  lang?: string;
  /** The tab `?tab=` named, so a linked page renders itself on the server. */
  initialTab?: SpacesTab;
}

/**
 * The sidebar in its collapsed width, holding the things that are not a
 * space's own: the app itself at the top, where a space would show its logo,
 * this page's own tabs below it, and the profile popout at the bottom. Nothing
 * else, because everything the real sidebar lists belongs to one space.
 */
function SpacesRail(props: {
  tabs: RailTab[];
  activeTab: SpacesTab;
  onSelect: (tab: SpacesTab) => void;
}) {
  return (
    <div
      class="sidebar sticky top-0 flex h-screen flex-none p-1.5"
      style={{
        width: `${MIN_SIDEBAR_WIDTH}px`,
        "--color-background": "var(--color-neutral-25)",
      }}
    >
      <div class="sidebar-panel before:backdrop-surface-blur after:surface-noise relative flex h-full w-full flex-col items-center overflow-hidden rounded-lg bg-background/90 [&>*]:relative [&>*]:z-10">
        <div class="mt-4xs flex aspect-square w-[2.375rem] flex-none items-center justify-center">
          <img
            src="/favicon_dark.png"
            alt="Vektor"
            class="app-logo-mark-light h-7 w-7 object-contain"
          />
          <img
            src="/favicon_light.png"
            alt="Vektor"
            class="app-logo-mark-dark h-7 w-7 object-contain"
          />
        </div>

        {/* A single tab is no choice to make, so the rail stays as it was. */}
        <Show when={props.tabs.length > 1}>
          <nav class="mt-4xs flex flex-none flex-col items-center gap-5xs">
            <For each={props.tabs}>
              {(tab) => (
                <button
                  type="button"
                  onClick={() => props.onSelect(tab.id)}
                  class="focus-ring flex h-9 w-9 items-center justify-center rounded-md transition-colors"
                  classList={{
                    "bg-primary-50 text-primary-600": props.activeTab === tab.id,
                    "text-neutral-600 hover:bg-neutral-100": props.activeTab !== tab.id,
                  }}
                  title={tab.label}
                  aria-label={tab.label}
                  aria-current={props.activeTab === tab.id ? "page" : undefined}
                >
                  <Icon name={tab.icon} class="h-5 w-5" />
                </button>
              )}
            </For>
          </nav>
        </Show>

        <div class="flex-1" />

        <div class="relative flex flex-none items-center py-3">
          <UserProfile />
        </div>
      </div>
    </div>
  );
}

function SpacesOverviewContainer() {
  const { spaces, isLoading, createSpace, deleteSpace, gainAccess, canCreateSpace } =
    useSpace();
  const toast = useToast();
  const { pinnedSpaceIds, togglePin } = usePinnedSpaces();
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [pendingDelete, setPendingDelete] = createSignal<OverviewSpace | null>(null);

  const overviewSpaces = createMemo(() => {
    const pinned = pinnedSpaceIds();
    return (spaces() ?? []).map((space: ApiSpace) => ({
      id: space.id,
      name: space.name,
      slug: space.slug,
      description: space.preferences?.description,
      members: space.memberCount,
      role: space.userRole,
      adminAccess: space.adminAccess,
      color: space.preferences?.brandColor,
      logoSvg: space.preferences?.logoSvg,
      pinned: pinned.has(space.id),
    }));
  });

  return (
    <main class="min-w-0 flex-1">
      <CreateSpaceDialog
        show={showCreateDialog()}
        onUpdateShow={setShowCreateDialog}
        onCreate={async (data) => {
          // Failures propagate on purpose: the dialog shows them in its form
          // error and stays open so the slug can be corrected.
          const newSpace = await createSpace(data.name, data.slug, {
            brandColor: data.brandColor,
            logoSvg: data.logoSvg,
          });
          window.location.href = `/${newSpace.slug}/`;
        }}
      />

      <DeleteSpaceDialog
        space={pendingDelete()}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async (spaceId) => {
          // Failures propagate on purpose: the dialog reports them and stays
          // open, since the space is still there.
          await deleteSpace(spaceId);
          setPendingDelete(null);
        }}
      />

      <SpacesOverview
        spaces={overviewSpaces()}
        loading={isLoading()}
        onTogglePin={togglePin}
        onCreate={() => setShowCreateDialog(true)}
        onDelete={setPendingDelete}
        onGainAccess={async (space) => {
          try {
            await gainAccess(space.id);
            toast.success(
              t("You now have owner access to {name}").replace("{name}", space.name),
            );
          } catch (error) {
            toast.error(
              error instanceof Error ? error.message : t("Failed to gain access"),
            );
          }
        }}
        canCreate={canCreateSpace() === true}
      />
    </main>
  );
}

function UsersOverviewContainer(props: {
  users?: InstanceUser[];
  loading: boolean;
  error: string | null;
  capped: boolean;
}) {
  const overviewUsers = createMemo(() =>
    (props.users ?? []).map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      groups: user.groups,
      joined: formatAbsoluteDate(user.createdAt),
    })),
  );

  return (
    <main class="min-w-0 flex-1">
      <UsersOverview
        users={overviewUsers()}
        // No register yet and nothing to report is the window before the caller
        // is known to be an admin, when the query has not run: still loading,
        // not an instance without a single account.
        loading={props.loading || (props.users === undefined && !props.error)}
        error={props.error}
        capped={props.capped}
      />
    </main>
  );
}

/**
 * The rail and the page it selects. Its own component rather than part of
 * `SpacesApp` because the tab the rail offers depends on who is asking, and only
 * a component under the query provider may ask.
 */
function SpacesShell(props: { initialTab?: SpacesTab }) {
  const [activeTab, setActiveTab] = createSignal<SpacesTab>(props.initialTab ?? "spaces");
  const { isInstanceAdmin, users, isLoading, error, capped } = useInstanceUsers(
    () => activeTab() === "users",
  );

  const tabs = createMemo<RailTab[]>(() => [
    { id: "spaces", label: t("Spaces"), icon: "grid-grid" },
    // The server answers the register to an admin and an empty list to everyone
    // else, so offering the tab to anyone else would only ever open a page that
    // reports the instance has nobody in it.
    ...(isInstanceAdmin() === true
      ? [{ id: "users", label: t("Users"), icon: "users" } as const]
      : []),
  ]);

  /** Keeps `?tab=` on the address so a page stays linkable and survives reload. */
  function selectTab(tab: SpacesTab) {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    if (tab === "spaces") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url);
  }

  // Anyone who typed `?tab=users` without administering the instance. Only once
  // that is known, so a linked register does not flash the space overview first.
  const resolvedTab = createMemo<SpacesTab>(() =>
    activeTab() === "users" && isInstanceAdmin() === false ? "spaces" : activeTab(),
  );

  return (
    <div class="flex min-h-screen">
      <SpacesRail tabs={tabs()} activeTab={resolvedTab()} onSelect={selectTab} />
      <Show when={resolvedTab() === "users"} fallback={<SpacesOverviewContainer />}>
        <UsersOverviewContainer
          users={users()}
          loading={isLoading()}
          error={error()}
          capped={capped()}
        />
      </Show>
      <ToastContainer />
    </div>
  );
}

/**
 * The island behind `/spaces`. Its own root rather than a route inside
 * `SpaceApp`: that router is based at `/{spaceSlug}/` and everything it mounts
 * assumes a space, which is the one thing this page does not have.
 */
export function SpacesApp(props: Props) {
  if (!isServer) {
    setClientLang(props.lang);
    api.setReplicaScope(props.replicaScope);
  }

  return (
    <QueryClientContext.Provider value={islandQueryClient()}>
      <SpacesShell initialTab={props.initialTab} />
    </QueryClientContext.Provider>
  );
}
