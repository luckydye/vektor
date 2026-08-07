import { useLocation, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { isServer } from "solid-js/web";
import type { AuditLog } from "#api/client.ts";
import { useAuditLogs } from "#composeables/useAuditLogs.ts";
import { useRevisions } from "#composeables/useRevisions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { t } from "#utils/lang.ts";
import { registerScopedAction } from "#utils/scopedAction.ts";
import { findMemberUser, userDisplayName } from "#utils/userDisplay.ts";
import { normalizeTimestamp } from "#utils/utils.ts";
import { DockedPanel } from "./DockedPanel.tsx";
import { DocumentActivityFeed } from "./DocumentActivityFeed.tsx";
import { PagerCursor } from "./PagerCursor.tsx";
import "@atrium-ui/elements/popover";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useMembers } from "#composeables/useMembers.ts";
import { useSync } from "#composeables/useSync.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  documentId: string;
}

function dispatchWindowEvent(event: Event) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(event);
}

export function RevisionsSidebar(props: Props) {
  const {
    revisions,
    getRevision,
    publishRevision,
    fetchHistory,
    isLoading: isLoadingHistory,
  } = useRevisions(() => props.documentId);

  const {
    auditLogs,
    isLoading: isLoadingAudit,
    isFetching: isFetchingAudit,
    error: auditError,
    fetchAuditLogs,
    hasPrevPage: hasPrevAuditPage,
    hasNextPage: hasNextAuditPage,
    nextPage: nextAuditPage,
    prevPage: prevAuditPage,
  } = useAuditLogs(props.documentId);

  const { currentSpaceId } = useSpace();
  const navigate = useNavigate();
  const location = useLocation();
  const { members } = useMembers();

  const [publishedRev, setPublishedRev] = createSignal<number | null>(null);
  const [isPublishing, setIsPublishing] = createSignal(false);
  // Tracked but not rendered here: RevisionView owns the banner. Kept so the
  // close handler can clear it.
  const [, setSelectedRevisionNumber] = createSignal<number | null>(null);

  const { toggle: toggleWindow, windows } = useDockedWindows();
  const isOpen = createMemo(() => windows().get("revisions")?.open ?? false);

  /** Sorted audit log entries, newest first. */
  const sortedEntries = createMemo(() =>
    [...auditLogs()].sort(
      (a, b) =>
        normalizeTimestamp(b.createdAt).getTime() -
        normalizeTimestamp(a.createdAt).getTime(),
    ),
  );

  const revisionsByNumber = createMemo(() => new Map(revisions().map((r) => [r.rev, r])));

  // ── User resolver passed to DocumentActivityFeed ────────────────────────────

  function getUser(userId?: string | null) {
    return findMemberUser(members(), userId);
  }

  function getUserName(userId?: string | null): string {
    return userDisplayName(getUser(userId), userId);
  }

  // ── Per-entry helpers used in the action slot ───────────────────────────────

  function isPublishedEntry(entry: AuditLog): boolean {
    return !!entry.revisionId && entry.revisionId === publishedRev();
  }

  function isSuggestionEntry(entry: AuditLog): boolean {
    if (!entry.revisionId) return false;
    const revision = revisionsByNumber().get(entry.revisionId);
    return revision != null && revision.status !== null;
  }

  function revisionStatusOf(entry: AuditLog): string | null {
    if (!entry.revisionId) return null;
    return revisionsByNumber().get(entry.revisionId)?.status ?? null;
  }

  /** The most recent entry in a group that has a revision (used for the header action). */
  function primaryRevisionEntry(items: AuditLog[]): AuditLog | undefined {
    return items.find((i) => !!i.revisionId);
  }

  // ── Data fetching ───────────────────────────────────────────────────────────

  async function fetchPublishedRev() {
    const spaceId = currentSpaceId();
    if (!spaceId) return;
    try {
      const response = await fetch(
        `/api/v1/spaces/${spaceId}/documents/${props.documentId}`,
      );
      if (response.ok) {
        const data = await response.json();
        setPublishedRev(data.document?.publishedRev || null);
      }
    } catch (err) {
      console.error("Failed to fetch published revision:", err);
    }
  }

  async function refresh() {
    await Promise.all([fetchAuditLogs(), fetchPublishedRev(), fetchHistory()]);
  }

  // ── Revision actions ────────────────────────────────────────────────────────

  /**
   * The returned path carries the router base ("/{space}/") — it comes from
   * `location.pathname` — so `navigate()` must pass `resolve: false` or the base
   * lands twice ("/space/space/…"). A revision on its own is viewed as-is; the
   * `base` a redline compares it against is added by RevisionView, which is
   * where the server resolves it.
   */
  function withRevisionQuery(revisionId: number): string {
    const query = new URLSearchParams(location.search);
    query.set("revision", String(revisionId));
    query.delete("base");
    return `${location.pathname}?${query.toString()}`;
  }

  async function viewRevision(revisionId: number | null | undefined) {
    if (!revisionId) return;
    const revision = await getRevision(revisionId);
    if (!revision) return;

    setSelectedRevisionNumber(revisionId);
    navigate(withRevisionQuery(revisionId), { replace: true, resolve: false });

    dispatchWindowEvent(
      new CustomEvent("revision:view", {
        detail: {
          revision: revisionId,
          content: revision.content,
          isSuggestion: revision.status !== null,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * `base` is optional: without it the server compares against the revision
   * this one was meant to change, and RevisionView writes the resolved pair
   * into the URL. The revision is fetched for its status rather than read from
   * the loaded history, because restoring `?revision=…&base=…` runs before the
   * activity feed has any entries. RevisionView fetches the redline itself.
   */
  async function showRevisionDiff(revisionId: number | null | undefined, base?: number) {
    if (!revisionId) return;
    const revision = await getRevision(revisionId);
    if (!revision) return;

    setSelectedRevisionNumber(revisionId);

    dispatchWindowEvent(
      new CustomEvent("revision:diff", {
        detail: { revision: revisionId, base, isSuggestion: revision.status !== null },
        bubbles: true,
        composed: true,
      }),
    );
  }

  async function publishRevisionAction(revisionId: number | null | undefined) {
    if (!revisionId) return;
    setIsPublishing(true);
    try {
      const success = await publishRevision(revisionId);
      if (success) {
        setPublishedRev(revisionId);
        await refresh();
      }
    } finally {
      setIsPublishing(false);
    }
  }

  function copyRevisionLink(revisionId: number | null | undefined) {
    if (!revisionId) return;
    navigator.clipboard.writeText(
      new URL(withRevisionQuery(revisionId), window.location.origin).href,
    );
  }

  function exitPopover(e: Event) {
    (e.target as Element | null)?.dispatchEvent(
      new CustomEvent("exit", { bubbles: true }),
    );
  }

  // ── Lifecycle / panel watcher ───────────────────────────────────────────────

  // Scoped: the activity panel needs a document, so the action must not linger
  // on the home page.
  registerScopedAction("revisions:toggle", {
    title: t("Activity"),
    icon: () => "activity",
    description: t("Open or close the document activity"),
    group: "document",
    run: async () => {
      toggleWindow("revisions", { side: "right", width: 420 });
    },
  });

  function onRevisionClose() {
    setSelectedRevisionNumber(null);
    const query = new URLSearchParams(location.search);
    query.delete("revision");
    query.delete("base");
    const search = query.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, {
      replace: true,
      resolve: false,
    });
  }

  /**
   * A `?revision=` in the URL opens that revision once the space is known — as
   * its redline against `&base=` when that rides along.
   *
   * Read during setup, not in `onMount`: effects run in creation order, so an
   * effect declared here would run *before* `onMount` filled these in, bail out
   * on the null, and — having read no signal on that path — never run again.
   * The panel only renders on the client, but SSR has no location to read.
   */
  const urlRevision = isServer
    ? null
    : (() => {
        const params = new URL(window.location.href).searchParams;
        const rev = Number.parseInt(params.get("revision") ?? "", 10);
        if (Number.isNaN(rev)) return null;
        const base = Number.parseInt(params.get("base") ?? "", 10);
        return { rev, base: Number.isNaN(base) ? null : base };
      })();

  // Latched, so a later space change cannot reopen what the user has closed.
  let urlRevisionOpened = false;

  createEffect(() => {
    // Read first: an early return above this line would leave the effect
    // tracking nothing, and the space resolves asynchronously on a cold load.
    const spaceId = currentSpaceId();
    if (!spaceId || urlRevisionOpened || urlRevision === null) return;
    urlRevisionOpened = true;
    void (urlRevision.base === null
      ? viewRevision(urlRevision.rev)
      : showRevisionDiff(urlRevision.rev, urlRevision.base));
  });

  onMount(() => {
    window.addEventListener("revision:close", onRevisionClose);
    onCleanup(() => window.removeEventListener("revision:close", onRevisionClose));
  });

  let previousOpen: boolean | undefined;
  createEffect(() => {
    const open = isOpen();
    const spaceId = currentSpaceId();
    if (open && spaceId) void refresh();
    if (open !== previousOpen) {
      previousOpen = open;
      dispatchWindowEvent(
        new CustomEvent("revisions:toggled", {
          detail: { isOpen: open },
          bubbles: true,
          composed: true,
        }),
      );
    }
  });

  useSync(
    currentSpaceId,
    () => [realtimeTopics.document(props.documentId)],
    (scopes) => {
      if (!scopes.includes(realtimeTopics.document(props.documentId))) return;

      if (isOpen()) void refresh();
      else void fetchPublishedRev();
    },
  );

  return (
    <DockedPanel
      id="revisions"
      title="Document Activity"
      defaultSide="right"
      defaultWidth={420}
    >
      <div class="relative flex h-full flex-col">
        <Show when={auditError()}>
          <div class="mx-4 mt-4 rounded-sm border border-red-200 bg-red-50 p-3 text-red-700 text-size-medium">
            {auditError()}
          </div>
        </Show>

        <Show
          when={
            !((isLoadingHistory() || isLoadingAudit()) && sortedEntries().length === 0)
          }
          fallback={
            <div class="flex flex-1 items-center justify-center">
              <div class="text-center">
                <Icon
                  class="mx-auto mb-2 h-8 w-8 animate-spin text-neutral-400"
                  name="refresh"
                />
                <p class="text-neutral-600 text-size-medium">Loading history...</p>
              </div>
            </div>
          }
        >
          <Show
            when={sortedEntries().length > 0}
            fallback={
              <div class="flex flex-1 items-center justify-center">
                <div class="px-4 text-center">
                  <Icon class="mx-auto mb-3 h-12 w-12 text-neutral-300" name="activity" />
                  <p class="font-medium text-neutral-600">No activity yet</p>
                  <p class="mt-1 text-neutral-500 text-size-medium">
                    Activity will appear here as you work
                  </p>
                </div>
              </div>
            }
          >
            <div class="flex-1 overflow-y-auto" data-scroll-container>
              <div class="px-2 py-2">
                <DocumentActivityFeed
                  entries={sortedEntries()}
                  getUserName={getUserName}
                  getUser={getUser}
                  headerActions={(items) => {
                    const primary = primaryRevisionEntry(items);
                    if (!primary) return null;
                    return (
                      <div class="shrink-0">
                        <a-popover-trigger showdelay="0" hidedelay="100">
                          <button
                            type="button"
                            slot="trigger"
                            class="inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-neutral-200"
                            title="Revision actions"
                          >
                            <Icon
                              class="h-[18px] w-[12px] text-neutral-500"
                              name="context-menu-more"
                            />
                          </button>

                          <a-popover class="group" placements="bottom-end">
                            <div class="revision-context-menu w-max py-1 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
                              <div class="revision-context-panel min-w-[224px] origin-top-right scale-95 rounded-lg border border-neutral-100 bg-background p-5xs shadow-large transition-transform duration-150 group-[&[enabled]]:scale-100">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    exitPopover(e);
                                    void viewRevision(primary.revisionId);
                                  }}
                                  class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-neutral-900 text-size-normal transition-colors hover:bg-primary-50 active:bg-primary-100"
                                >
                                  <Icon class="h-4 w-4 flex-none" name="eye" />
                                  View Revision
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    exitPopover(e);
                                    void showRevisionDiff(primary.revisionId);
                                  }}
                                  class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-neutral-900 text-size-normal transition-colors hover:bg-primary-50 active:bg-primary-100"
                                >
                                  <Icon class="h-4 w-4 flex-none" name="paste" />
                                  Show Diff
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    exitPopover(e);
                                    copyRevisionLink(primary.revisionId);
                                  }}
                                  class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-neutral-900 text-size-normal transition-colors hover:bg-primary-50 active:bg-primary-100"
                                >
                                  <Icon class="h-4 w-4 flex-none" name="copy" />
                                  Copy Link
                                </button>
                                <Show
                                  when={
                                    !isPublishedEntry(primary) &&
                                    !isSuggestionEntry(primary)
                                  }
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      exitPopover(e);
                                      void publishRevisionAction(primary.revisionId);
                                    }}
                                    class={`flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-neutral-900 text-size-normal transition-colors hover:bg-primary-50 active:bg-primary-100 disabled:cursor-not-allowed disabled:opacity-50`}
                                    disabled={isPublishing()}
                                  >
                                    <Icon class="h-4 w-4 flex-none" name="publish" />
                                    Publish Revision
                                  </button>
                                </Show>
                              </div>
                            </div>
                          </a-popover>
                        </a-popover-trigger>
                      </div>
                    );
                  }}
                  entryActions={(entry) => (
                    <Show
                      when={isPublishedEntry(entry)}
                      fallback={
                        <Show when={isSuggestionEntry(entry)}>
                          <span class="shrink-0 self-center rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-px font-medium text-amber-600 text-size-extra-small uppercase tracking-wide">
                            {revisionStatusOf(entry) === "applied"
                              ? "Applied"
                              : "Suggestion"}
                          </span>
                        </Show>
                      }
                    >
                      <span class="shrink-0 self-center rounded-sm border border-blue-200 bg-blue-50 px-1.5 py-px font-medium text-blue-600 text-size-extra-small uppercase tracking-wide">
                        Published
                      </span>
                    </Show>
                  )}
                />
              </div>
            </div>
          </Show>
        </Show>

        <PagerCursor
          class="shrink-0 px-3 py-2"
          hasPrevPage={hasPrevAuditPage()}
          hasNextPage={hasNextAuditPage()}
          disabled={isFetchingAudit()}
          onPrev={prevAuditPage}
          onNext={nextAuditPage}
        />
      </div>
    </DockedPanel>
  );
}
