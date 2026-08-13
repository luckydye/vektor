import { createMemo, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { api } from "#api/client.ts";
import { islandQueryClient } from "#composeables/islandQueryClient.ts";
import { QueryClientContext } from "#composeables/query.ts";
import { usePinnedSpaces } from "#composeables/usePinnedSpaces.ts";
import { type Space as ApiSpace, useSpace } from "#composeables/useSpace.ts";
import { setClientLang } from "#utils/lang.ts";
import { MIN_SIDEBAR_WIDTH } from "#utils/sidebarState.ts";
import { CreateSpaceDialog } from "./CreateSpaceDialog.tsx";
import { SpacesOverview } from "./SpacesOverview.tsx";
import { UserProfile } from "./UserProfile.tsx";

interface Props {
  replicaScope?: string;
  lang?: string;
}

/**
 * The sidebar in its collapsed width, holding the two things that are not a
 * space's own: the app itself at the top, where a space would show its logo,
 * and the profile popout at the bottom. Nothing in between, because everything
 * the real sidebar lists belongs to one space.
 */
function SpacesRail() {
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

        <div class="flex-1" />

        <div class="relative flex flex-none items-center py-3">
          <UserProfile />
        </div>
      </div>
    </div>
  );
}

function SpacesOverviewContainer() {
  const { spaces, isLoading, createSpace, canCreateSpace } = useSpace();
  const { pinnedSpaceIds, togglePin } = usePinnedSpaces();
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);

  const overviewSpaces = createMemo(() => {
    const pinned = pinnedSpaceIds();
    return (spaces() ?? []).map((space: ApiSpace) => ({
      id: space.id,
      name: space.name,
      slug: space.slug,
      description: space.preferences?.description,
      members: space.memberCount,
      role: space.userRole,
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

      <SpacesOverview
        spaces={overviewSpaces()}
        loading={isLoading()}
        onTogglePin={togglePin}
        onCreate={() => setShowCreateDialog(true)}
        canCreate={canCreateSpace() === true}
      />
    </main>
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
      <div class="flex min-h-screen">
        <SpacesRail />
        <SpacesOverviewContainer />
      </div>
    </QueryClientContext.Provider>
  );
}
