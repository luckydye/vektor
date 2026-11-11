import { useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { twMerge } from "tailwind-merge";
import { canAccessSettings, isOwner } from "#acl/permissions.ts";
import { confirmDialog } from "#composeables/useDialogs.ts";
import { usePinnedSpaces } from "#composeables/usePinnedSpaces.ts";
import { useRoute } from "#composeables/useRoute.ts";
import {
  PALETTE_ACTION_ID,
  type QuickSearchResult,
  registerInlineQuickSearch,
  useQuickSearch,
} from "#composeables/useQuickSearch.ts";
import { type Space as ApiSpace, useSpace } from "#composeables/useSpace.ts";
import { useSpaceSettingsActions } from "#composeables/useSpaceSettingsActions.ts";
import { extensions } from "#extensions/manager.ts";
import { Actions } from "#utils/actions.ts";
import { spaceSelectorSlots } from "#utils/pinnedSpaces.ts";
import { spacePath } from "#utils/utils.ts";
import { Button } from "./Button.tsx";
import { CreateSpaceDialog } from "./CreateSpaceDialog.tsx";
import { DocumentTree, type DocumentTreeHandle } from "./DocumentTree.tsx";
import { Icon } from "./Icon.tsx";
import { MenuLink } from "./MenuLink.tsx";
import { PinnedDocuments } from "./PinnedDocuments.tsx";
import { QuickSearchResults } from "./QuickSearchResults.tsx";
import { SpaceSelector } from "./SpaceSelector.tsx";
import { UserProfile } from "./UserProfile.tsx";
import { useToast } from "#composeables/useToast.ts";
import { useTranslation } from "#composeables/useTranslation.ts";

export function Navigation() {
  const t = useTranslation();

  const navigate = useNavigate();
  const [documentTree, setDocumentTree] = createSignal<DocumentTreeHandle | null>(null);
  const { pathname, documentSlug } = useRoute();
  const {
    currentSpace,
    spaces,
    createSpace,
    leaveSpace,
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

  // A space reached through admin rights is not one the viewer belongs to, so
  // there is nothing for them to leave.
  const userCanLeaveSpace = createMemo(() => {
    const space = currentSpace();
    return !isLoading() && !!space && !isOwner(space.userRole) && !space.adminAccess;
  });

  async function handleLeaveSpace() {
    const space = currentSpace();
    if (!space) return;
    if (
      !(await confirmDialog(
        t("Leave {name}? You will lose access until someone invites you again.").replace(
          "{name}",
          space.name,
        ),
        { tone: "danger", confirmLabel: t("Leave space") },
      ))
    )
      return;

    try {
      await leaveSpace(space.id);
      window.location.href = "/spaces";
    } catch (error) {
      useToast().error(
        error instanceof Error ? error.message : t("Failed to leave space"),
      );
    }
  }

  // Quick search inline, as in macOS Settings: typing swaps the navigation for
  // results, and clearing the field brings it back.
  const [searchQuery, setSearchQuery] = createSignal("");
  const [selectedResult, setSelectedResult] = createSignal(0);
  // The keyboard selection only means something while typing; otherwise only the
  // open document is marked.
  const [isSearchFocused, setIsSearchFocused] = createSignal(false);
  const isSearching = createMemo(() => searchQuery().trim() !== "");
  const quickSearch = useQuickSearch({ query: searchQuery, active: isSearching });
  let searchInput: HTMLInputElement | undefined;
  let searchResults: HTMLDivElement | undefined;

  createEffect(on(searchQuery, () => setSelectedResult(0), { defer: true }));

  function clearSearch() {
    setSearchQuery("");
  }

  function runSearchResult(result: QuickSearchResult, index: number) {
    setSelectedResult(index);
    quickSearch.runResult(result);
    // A document opens beside the results so the next match is one click away;
    // anything else leaves the search behind.
    if (result.type !== "document") {
      clearSearch();
      searchInput?.blur();
    }
  }

  function moveSelection(step: number) {
    const last = quickSearch.results().length - 1;
    setSelectedResult((index) => Math.max(0, Math.min(last, index + step)));
    searchResults
      ?.querySelector(`[data-result-index="${selectedResult()}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (searchQuery()) clearSearch();
      else searchInput?.blur();
    } else if (!isSearching()) {
      return;
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const result = quickSearch.results()[selectedResult()];
      if (result) runSearchResult(result, selectedResult());
    }
  }

  onCleanup(
    registerInlineQuickSearch(() => {
      // Hidden by the collapsed sidebar or the mobile layout: let the palette open.
      if (!searchInput || searchInput.getClientRects().length === 0) return false;
      searchInput.focus();
      searchInput.select();
      return true;
    }),
  );

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

  useSpaceSettingsActions();

  return (
    <div class="z-1 flex h-full flex-col">
      <div class="sticky top-0 z-10 flex-none rounded-t-md px-4xs @max-xs:px-1.5 pt-4xs pb-5xs">
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
          canCreateSpaces={canCreateSpace() === true}
          canLeave={userCanLeaveSpace()}
          loading={isLoading()}
          onSelect={(space) => {
            const full = spaces()?.find((s: ApiSpace) => s.id === space.id);
            if (full) window.location.href = `/${full.slug}/`;
          }}
          onCreate={() => setShowCreateDialog(true)}
          onLeave={() => void handleLeaveSpace()}
        />
      </div>

      <div class="flex flex-none flex-col gap-0.5 px-3xs @max-xs:px-3xs pt-3xs">
        {/* Collapsed, the sidebar has no room for results: the icon opens the palette. */}
        <button
          type="button"
          class="button-with-icon mb-xs flex min-h-[36px] max-md:hidden @xs:hidden w-full cursor-pointer items-center justify-start rounded-lg border border-neutral-400/25 bg-neutral-25 px-3xs text-left text-neutral-500 text-size-normal transition-colors hover:bg-primary-50 hover:transition-none active:bg-primary-100"
          title={t("Quick Search")}
          onClick={() => Actions.run(PALETTE_ACTION_ID)}
        >
          <Icon name="search" />
        </button>

        <label class="button-with-icon mb-xs flex min-h-[36px] @max-xs:hidden w-full cursor-text items-center rounded-lg border border-neutral-400/25 bg-neutral-25 px-3xs text-neutral-500 text-size-normal transition-colors hover:bg-primary-50 hover:transition-none focus-within:border-primary-300 focus-within:bg-background">
          <Icon name="search" />
          <input
            ref={searchInput}
            type="text"
            value={searchQuery()}
            onInput={(event) => setSearchQuery(event.currentTarget.value)}
            onFocus={() => {
              setIsSearchFocused(true);
              void quickSearch.loadHistory();
            }}
            onBlur={() => setIsSearchFocused(false)}
            onKeyDown={handleSearchKeydown}
            placeholder={t("Quick Search")}
            aria-label={t("Quick Search")}
            autocomplete="off"
            spellcheck={false}
            class="ml-3xs min-w-0 flex-1 bg-transparent text-neutral-900 outline-none placeholder:text-neutral-500"
          />
          <Show
            when={searchQuery()}
            fallback={<a-shortcut class="flex-none" data-shortcut="mod-k" />}
          >
            <button
              type="button"
              class="flex flex-none items-center rounded-sm p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-900"
              title={t("Clear search")}
              aria-label={t("Clear search")}
              onClick={() => {
                clearSearch();
                searchInput?.focus();
              }}
            >
              <Icon class="h-3.5 w-3.5" name="cancel" />
            </button>
          </Show>
        </label>
      </div>

      <div class="sidebar-scroll min-w-[60px] flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
        <Show when={isSearching()}>
          <div ref={searchResults} class="@max-xs:hidden px-3xs pt-3xs pb-s">
            <QuickSearchResults
              results={quickSearch.results()}
              sectionStarts={quickSearch.sectionStarts()}
              selectedIndex={isSearchFocused() ? selectedResult() : -1}
              activeDocumentSlug={documentSlug()}
              onRun={runSearchResult}
            />
          </div>
        </Show>

        {/* Kept mounted while searching, so the tree's state survives the search. */}
        <nav
          class={twMerge(
            "@container flex flex-col gap-3xs",
            isSearching() && "hidden @max-xs:flex",
          )}
        >
          <div class="flex flex-none flex-col gap-0.5 px-3xs @max-xs:px-3xs pt-3xs">
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
            <div class="flex flex-none flex-col gap-0.5 px-3xs @max-xs:px-3xs">
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

          <PinnedDocuments />

          <div class="@max-xs:hidden px-5xs pb-s">
            {/* The hint gives the lone Done button something to belong to, and says
                what the mode is for — nothing else on screen does. */}
            <Show when={documentTree()?.isEditMode}>
              <div class="mb-1 flex min-h-[20px] items-center justify-between gap-3xs px-3xs">
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
              </div>
            </Show>

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
