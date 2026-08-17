import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { canAccessSettings, canEdit } from "#acl/permissions.ts";
import { usePinnedSpaces } from "#composeables/usePinnedSpaces.ts";
import { useRoute } from "#composeables/useRoute.ts";
import { type Space as ApiSpace, useSpace } from "#composeables/useSpace.ts";
import { extensions } from "#extensions/manager.ts";
import { Actions } from "#utils/actions.ts";
import { t } from "#utils/lang.ts";
import { spaceSelectorSlots } from "#utils/pinnedSpaces.ts";
import { spacePath } from "#utils/utils.ts";
import { Button } from "./Button.tsx";
import { CreateSpaceDialog } from "./CreateSpaceDialog.tsx";
import { DocumentTree, type DocumentTreeHandle } from "./DocumentTree.tsx";
import { Icon } from "./Icon.tsx";
import { MenuLink } from "./MenuLink.tsx";
import { SpaceSelector } from "./SpaceSelector.tsx";
import { UserProfile } from "./UserProfile.tsx";

export function Navigation() {
  const navigate = useNavigate();
  const [documentTree, setDocumentTree] = createSignal<DocumentTreeHandle | null>(null);
  const { pathname } = useRoute();
  const {
    currentSpace,
    spaces,
    createSpace,
    canCreateSpace,
    isLoading: spaceIsLoading,
  } = useSpace();
  const { pinnedSpaceIds } = usePinnedSpaces();

  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [extensionMenuLinks, setExtensionMenuLinks] = createSignal<
    Array<{ extensionId: string; route: string; title: string; icon?: string }>
  >([]);

  const activeRoute = createMemo(() => {
    const path = pathname().replace(/\/+$/, "");
    if (path.includes("/x/")) {
      const match = path.match(/\/x\/(.+)/);
      return match ? `x/${match[1]}` : "";
    }
    if (path.includes("/settings")) return "settings";
    if (path === "" || path === spacePath(currentSpace()?.slug, "").replace(/\/+$/, "")) {
      return "home";
    }
    return "";
  });

  const isLoading = createMemo(() => !pathname() || spaceIsLoading());

  const uiSpaces = createMemo(() =>
    (spaces() ?? []).map((space: ApiSpace) => ({
      id: space.id,
      name: space.name,
      members: space.memberCount,
      color: space.preferences?.brandColor,
      logoSvg: space.preferences?.logoSvg,
      pinned: pinnedSpaceIds().has(space.id),
    })),
  );

  const selectorSpaces = createMemo(() =>
    spaceSelectorSlots(uiSpaces(), pinnedSpaceIds()),
  );

  // Looked up separately: an unpinned current space can fall outside the listed
  // ones, and the trigger still has to name it.
  const currentUiSpace = createMemo(
    () => uiSpaces().find((space) => space.id === currentSpace()?.id) ?? null,
  );

  const userCanAccessSettings = createMemo(
    () => !isLoading() && canAccessSettings(currentSpace()?.userRole),
  );
  const userCanEdit = createMemo(() => !isLoading() && canEdit(currentSpace()?.userRole));

  function updateExtensionMenuLinks() {
    setExtensionMenuLinks(extensions.getMenuLinks());
  }

  onMount(() => {
    updateExtensionMenuLinks();
    window.addEventListener("extensions:loaded", updateExtensionMenuLinks);
    onCleanup(() =>
      window.removeEventListener("extensions:loaded", updateExtensionMenuLinks),
    );
  });

  Actions.register("document:create", {
    title: t("Create Document"),
    description: t("Create a new document"),
    run: async () => {
      if (currentSpace()) navigate("/new");
    },
  });

  Actions.register("find:open", {
    title: t("Find"),
    description: t("Open find document dialog"),
    run: async () => {
      if (currentSpace()) navigate("/search");
    },
  });

  Actions.mapShortcut("mod-shift-f", "find:open");

  return (
    <div class="z-1 flex h-full flex-col">
      <div class="sticky top-0 z-10 flex-none rounded-t-md px-5xs py-5xs">
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
        <SpaceSelector
          spaces={selectorSpaces()}
          current={currentUiSpace()}
          allSpacesHref="/spaces"
          canCreateDocs={userCanEdit()}
          canCreateSpaces={canCreateSpace() === true}
          loading={isLoading()}
          onSelect={(space) => {
            const full = spaces()?.find((s: ApiSpace) => s.id === space.id);
            if (full) window.location.href = `/${full.slug}/`;
          }}
          onCreate={() => setShowCreateDialog(true)}
          onCreateDoc={() => Actions.run("document:create")}
        />
      </div>

      <div class="sidebar-scroll min-w-[60px] flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
        <nav class="@container flex flex-col gap-3xs">
          <div class="flex flex-none flex-col gap-0.5 px-3xs pt-5xs">
            <button
              type="button"
              class="button-with-icon mb-4xs flex min-h-[36px] w-full cursor-pointer items-center @max-xs:justify-center rounded-lg border border-neutral-400/25 bg-neutral-25 px-3xs text-left text-neutral-500 transition-colors hover:bg-primary-50 hover:transition-none active:bg-primary-100"
              title={t("Quick Search")}
              onClick={() => Actions.run("ui:toggle:palatte")}
            >
              <Icon name="search" />
              <span class="@max-xs:hidden flex-1 truncate text-size-normal">
                {t("Quick Search")}
              </span>
              <a-shortcut class="@max-xs:hidden! flex-none" data-shortcut="mod-k" />
            </button>
            <MenuLink
              icon="home"
              text={t("Activity")}
              href={spacePath(currentSpace()?.slug, "/")}
              isActive={activeRoute() === "home"}
            />
            <Show when={userCanAccessSettings()}>
              <MenuLink
                icon="settings"
                text={t("Settings")}
                href={spacePath(currentSpace()?.slug, "/settings")}
                isActive={activeRoute() === "settings"}
              />
            </Show>
          </div>

          <Show when={extensionMenuLinks().length > 0 && !isLoading()}>
            <div class="flex flex-none flex-col gap-0.5 px-3xs">
              <For each={extensionMenuLinks()}>
                {(link) => (
                  <MenuLink
                    icon="extension"
                    iconSvg={link.icon}
                    text={link.title}
                    href={spacePath(currentSpace()?.slug, `/x/${link.route}`)}
                    isActive={activeRoute() === `x/${link.route}`}
                  />
                )}
              </For>
            </div>
          </Show>

          <div class="@max-xs:hidden px-5xs pt-4xs pb-s">
            <div class="mx-4xs border-neutral-400/25 border-b"></div>

            {/* The hint gives the lone Done button something to belong to, and says
                what the mode is for — nothing else on screen does. */}
            <div class="mb-1 flex min-h-[20px] items-center justify-between gap-3xs px-3xs">
              <Show when={documentTree()?.isEditMode}>
                <span class="truncate text-neutral-500 text-size-extra-small">
                  {t("Drag to reorder")}
                </span>
                <Button
                  variant="ghost"
                  size="small"
                  text={t("Done")}
                  ariaLabel={t("Done rearranging")}
                  onClick={() => documentTree()?.toggleEditMode()}
                />
              </Show>
            </div>

            <DocumentTree ref={setDocumentTree} />
          </div>
        </nav>
      </div>

      <div class="relative flex flex-none items-center px-1 py-3">
        <UserProfile />
      </div>
    </div>
  );
}
