import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import type { AuditLog } from "#api/client.ts";
import {
  type ActivityGroup,
  getAuditEventAction,
  getAuditEventLabel,
  getEntryChangeLabel,
  groupActivityEntries,
  hasPropertyChange,
} from "#utils/auditActivity.ts";
import { t } from "#utils/lang.ts";
import type { DisplayUser } from "#utils/userDisplay.ts";
import { normalizeTimestamp } from "#utils/utils.ts";
import "./AvatarElement.ts";
import { Icon, type IconName } from "./Icon.tsx";

interface Props {
  entries: AuditLog[];
  getUserName: (userId?: string | null) => string;
  getUser?: (userId?: string | null) => DisplayUser | undefined;
  headerActions?: (items: AuditLog[]) => JSX.Element;
  entryActions?: (entry: AuditLog) => JSX.Element;
}

function getGroupAction(items: AuditLog[]): string {
  return items[0] ? getAuditEventAction(items[0].event) : t("updated");
}

function getDocumentActivityIcon(entry: AuditLog): IconName {
  if (entry.event === "publish") return "confirmation";
  return "edit-entry";
}

function getMoreChangesLabel(count: number): string {
  return `${count} ${count === 1 ? t("more change") : t("more changes")}`;
}

function isVisibleDocumentEntry(entry: AuditLog): boolean {
  return entry.event !== "view";
}

function getHiddenDocumentEntryCount(items: AuditLog[]): number {
  return Math.max(0, items.filter(isVisibleDocumentEntry).length - 3);
}

function hasDocumentDelta(entry: AuditLog): boolean {
  return (
    hasPropertyChange(entry) &&
    (entry.details?.previousValue !== undefined ||
      entry.details?.newValue !== undefined ||
      entry.event === "property_delete")
  );
}

function activityMinute(entry?: AuditLog): string {
  if (!entry) return "";
  try {
    const date = normalizeTimestamp(entry.createdAt as string);
    date.setSeconds(0, 0);
    return date.toISOString();
  } catch {
    return String(entry.createdAt);
  }
}

function getDocumentBatchKey(entry: AuditLog | undefined, userId: string | null): string {
  if (!entry) return "";
  return [
    userId,
    entry.docId,
    getAuditEventAction(entry.event),
    entry.revisionId ?? activityMinute(entry),
  ].join(":");
}

function isSameDocumentBatch(entry: AuditLog, group: ActivityGroup): boolean {
  return (
    getDocumentBatchKey(group.items[0], group.userId) ===
    getDocumentBatchKey(entry, entry.userId ?? null)
  );
}

export function DocumentActivityFeed(props: Props) {
  const [expandedGroups, setExpandedGroups] = createSignal(new Set<string>());

  function isGroupExpanded(groupId: string): boolean {
    return expandedGroups().has(groupId);
  }

  function toggleGroup(groupId: string): void {
    const next = new Set(expandedGroups());
    if (next.has(groupId)) {
      next.delete(groupId);
    } else {
      next.add(groupId);
    }
    setExpandedGroups(next);
  }

  function getDocumentEntries(group: ActivityGroup): AuditLog[] {
    const entries = group.items.filter(isVisibleDocumentEntry);
    return isGroupExpanded(group.id) ? entries : entries.slice(0, 3);
  }

  const activityGroups = createMemo(() =>
    groupActivityEntries(props.entries, isSameDocumentBatch),
  );

  return (
    <div class="@container space-y-4">
      <For each={activityGroups()}>
        {(group) => (
          <>
            <Show when={group.showBucket}>
              <div class="px-1 font-medium text-neutral-500 text-size-small">
                {group.bucketLabel}
              </div>
            </Show>

            <article class="rounded-lg border border-neutral-100 bg-neutral-10 px-3 py-3">
              <div class="flex items-start gap-3">
                <vektor-avatar
                  size="small"
                  attr:user-id={group.userId ?? undefined}
                  prop:user={props.getUser?.(group.userId)}
                />

                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-2">
                    <div class="flex min-w-0 flex-1 items-baseline gap-1 text-size-small leading-small">
                      <span class="truncate font-semibold text-neutral-900">
                        {props.getUserName(group.userId)}
                      </span>
                      <span class="shrink-0 text-neutral-700">
                        {getGroupAction(group.items)}
                      </span>
                    </div>
                    {props.headerActions?.(group.items)}
                  </div>

                  <div class="mt-2.5 space-y-2">
                    <For each={getDocumentEntries(group)}>
                      {(entry) => (
                        <div class="flex min-w-0 items-center gap-3">
                          <Icon
                            class="h-4 w-4 shrink-0 text-neutral-400"
                            name={getDocumentActivityIcon(entry)}
                          />
                          <div class="min-w-0 flex-1 truncate font-medium text-neutral-600 text-size-small">
                            {getEntryChangeLabel(entry) ??
                              getAuditEventLabel(entry.event)}
                          </div>

                          <Show when={hasDocumentDelta(entry)}>
                            <div class="flex max-w-[55%] shrink-0 items-center gap-1.5 rounded-md bg-neutral-50 px-2 py-0.5 text-neutral-500 text-size-small">
                              <Show
                                when={entry.details?.previousValue}
                                fallback={<span class="text-neutral-400">—</span>}
                              >
                                <span
                                  class="min-w-0 max-w-[16ch] truncate"
                                  title={entry.details?.previousValue}
                                >
                                  {entry.details?.previousValue}
                                </span>
                              </Show>
                              <span class="font-mono text-neutral-400 text-size-extra-small">
                                →
                              </span>
                              <Show
                                when={entry.event === "property_delete"}
                                fallback={
                                  <Show
                                    when={entry.details?.newValue}
                                    fallback={<span class="text-neutral-400">—</span>}
                                  >
                                    <span
                                      class="min-w-0 max-w-[16ch] truncate text-neutral-700"
                                      title={entry.details?.newValue}
                                    >
                                      {entry.details?.newValue}
                                    </span>
                                  </Show>
                                }
                              >
                                <span class="shrink-0 text-red-500">{t("removed")}</span>
                              </Show>
                            </div>
                          </Show>

                          {props.entryActions?.(entry)}
                        </div>
                      )}
                    </For>

                    <Show when={getHiddenDocumentEntryCount(group.items) > 0}>
                      <button
                        type="button"
                        class="flex items-center gap-3 font-medium text-neutral-500 text-size-small hover:text-neutral-700"
                        onClick={() => toggleGroup(group.id)}
                      >
                        <Icon
                          class={twMerge(
                            "h-4 w-4 shrink-0 text-neutral-400 transition-transform",
                            isGroupExpanded(group.id) && "rotate-45",
                          )}
                          name="add"
                        />
                        <span>
                          {isGroupExpanded(group.id)
                            ? t("Show fewer changes")
                            : getMoreChangesLabel(
                                getHiddenDocumentEntryCount(group.items),
                              )}
                        </span>
                      </button>
                    </Show>
                  </div>
                </div>
              </div>
            </article>
          </>
        )}
      </For>
    </div>
  );
}
