import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  commandPaletteIcon,
  extensionIcon,
  homeIcon,
  searchIcon,
  settingsIcon,
} from "#assets/icons.ts";
import { canAccessSettings, canEdit } from "#composeables/usePermissions.ts";
import { useRoute } from "#composeables/useRoute.solid.ts";
import { type Space as ApiSpace, useSpace } from "#composeables/useSpace.solid.ts";
import { extensions } from "#extensions/manager.ts";
import { Actions } from "#utils/actions.ts";
import { t } from "#utils/lang.ts";
import { spacePath } from "#utils/utils.ts";
import { CreateSpaceDialog } from "./CreateSpaceDialog.tsx";
import { DocumentTree } from "./DocumentTree.tsx";
import { MenuLink } from "./MenuLink.tsx";
import { SpaceSelector } from "./SpaceSelector.tsx";
import { UserProfile } from "./UserProfile.tsx";

export function Navigation() {
  const navigate = useNavigate();
  const { pathname } = useRoute();
  const { currentSpace, spaces, createSpace, isLoading: spaceIsLoading } = useSpace();

  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [extensionMenuLinks, setExtensionMenuLinks] = createSignal<
    Array<{ extensionId: string; route: string; title: string; icon?: string }>
  >([]);

  const activeRoute = createMemo(() => {
    const path = pathname();
    if (path.includes("/search")) return "search";
    if (path.includes("/x/")) {
      const match = path.match(/\/x\/(.+)/);
      return match ? `x/${match[1]}` : "";
    }
    if (path.includes("/settings")) return "settings";
    if (path === "/" || path.split("/").filter(Boolean).length === 0) return "home";
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
    })),
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

  Actions.mapShortcut("meta-shift-f", "find:open");

  return (
    <div class="z-1 flex h-full flex-col">
      <div class="sticky top-0 z-10 flex-none rounded-t-md px-5xs py-5xs">
        <CreateSpaceDialog
          show={showCreateDialog()}
          onUpdateShow={setShowCreateDialog}
          onCreate={async (data) => {
            try {
              const newSpace = await createSpace(data.name, data.slug, {
                brandColor: data.brandColor,
                logoSvg: data.logoSvg,
              });
              window.location.href = `/${newSpace.slug}/`;
            } catch (err) {
              console.error("Failed to create space:", err);
            }
          }}
        />
        <SpaceSelector
          spaces={uiSpaces()}
          value={currentSpace()?.id}
          canCreateDocs={userCanEdit()}
          loading={isLoading()}
          onSelect={(space) => {
            const full = spaces()?.find((s: ApiSpace) => s.id === space.id);
            if (full) window.location.href = `/${full.slug}/`;
          }}
          onCreate={() => setShowCreateDialog(true)}
          onCreateDoc={() => Actions.run("document:create")}
        />
      </div>

      <wiki-scroll
        name="navigation"
        class="min-w-[60px] flex-1 overflow-y-auto overflow-x-hidden"
      >
        <nav class="@container flex flex-col gap-3xs">
          <div class="flex flex-none flex-col gap-0.5 px-3xs pt-5xs">
            <div class="flex items-center gap-px">
              <MenuLink
                class="flex-1"
                icon={homeIcon}
                text={t("Home")}
                href={spacePath(currentSpace()?.slug, "/")}
                isActive={activeRoute() === "home"}
              />
              <button
                type="button"
                class="inline-flex @max-sm:hidden min-h-[32px] w-8 flex-none cursor-pointer items-center justify-center rounded-md text-neutral-800 transition-colors hover:bg-primary-50 hover:transition-none active:bg-primary-100"
                title={t("Command Palette")}
                onClick={() => Actions.run("ui:toggle:palatte")}
              >
                <span innerHTML={commandPaletteIcon} class="icon inline flex-none" />
              </button>
            </div>
            <Show when={userCanAccessSettings()}>
              <MenuLink
                icon={settingsIcon}
                text={t("Settings")}
                href={spacePath(currentSpace()?.slug, "/settings")}
                isActive={activeRoute() === "settings"}
              />
            </Show>
            <MenuLink
              icon={searchIcon}
              text={t("Find")}
              href={spacePath(currentSpace()?.slug, "/search")}
              isActive={activeRoute() === "search"}
            >
              <a-shortcut
                class="@max-xs:hidden! ml-6 flex-none"
                data-shortcut="cmd-shift-f"
              />
            </MenuLink>
          </div>

          <Show when={extensionMenuLinks().length > 0 && !isLoading()}>
            <div class="flex flex-none flex-col gap-0.5 px-3xs">
              <For each={extensionMenuLinks()}>
                {(link) => (
                  <MenuLink
                    icon={link.icon || extensionIcon}
                    text={link.title}
                    href={spacePath(currentSpace()?.slug, `/x/${link.route}`)}
                    isActive={activeRoute() === `x/${link.route}`}
                  />
                )}
              </For>
            </div>
          </Show>

          <div class="@max-xs:hidden px-5xs py-s">
            <div class="mb-1 flex min-h-[20px] items-center justify-between gap-3xs px-5xs">
              <h3 class="font-medium text-neutral-900 text-size-extra-small uppercase tracking-wider opacity-50">
                {t("Categories")}
              </h3>
              {/* The "Done rearranging" button reads the tree's edit mode
                  through a template ref. It returns with the real DocumentTree
                  in phase 5 — a ref into a placeholder would assert nothing. */}
            </div>

            <DocumentTree />
          </div>
        </nav>
      </wiki-scroll>

      <div class="relative flex flex-none items-center px-1 py-3">
        <UserProfile />
      </div>
    </div>
  );
}
