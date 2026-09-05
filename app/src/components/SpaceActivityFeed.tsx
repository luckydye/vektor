import { createMemo, For, Index, mergeProps, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import type { AuditLog } from "#api/client.ts";
import { useSpaceActivity } from "#composeables/useSpaceActivity.ts";
import {
  type ActivityGroup,
  getAuditEventAction,
  getEntryChangeLabel,
  groupActivityEntries,
  isPermissionEvent,
} from "#utils/auditActivity.ts";
import { normalizeTimestamp } from "#utils/datetime.ts";
import { t } from "#utils/lang.ts";
import "./AvatarElement.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import { Icon } from "./Icon.tsx";

interface CompactActivityBatch {
  id: string;
  docId: string;
  action: string;
  isPermission: boolean;
  entries: AuditLog[];
}

interface Props {
  spaceId: string;
  limit?: number;
}

function getCompactActivityBatches(
  items: AuditLog[],
  lang: string,
): CompactActivityBatch[] {
  const batches: CompactActivityBatch[] = [];
  const batchMap = new Map<string, CompactActivityBatch>();

  for (const entry of items) {
    if (entry.event === "view") continue;

    const action = getAuditEventAction(entry.event, lang);
    const isPermission = isPermissionEvent(entry.event);
    const key = `${isPermission ? "permissions" : entry.docId}:${action}`;
    let batch = batchMap.get(key);

    if (!batch) {
      batch = { id: key, docId: entry.docId, action, isPermission, entries: [] };
      batchMap.set(key, batch);
      batches.push(batch);
    }

    batch.entries.push(entry);
  }

  return batches;
}

function getBatchChanges(batch: CompactActivityBatch, lang: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const entry of batch.entries) {
    const label = getEntryChangeLabel(entry, lang);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }

  return labels;
}

function getBatchChangeCount(batch: CompactActivityBatch, lang: string): number {
  return Math.max(getBatchChanges(batch, lang).length, batch.entries.length);
}

function getChangeCountLabel(lang: string, count: number): string {
  return `${count} ${count === 1 ? t("change", lang) : t("changes", lang)}`;
}

function getBatchSummary(batch: CompactActivityBatch, lang: string): string {
  if (batch.isPermission) {
    const changes = getBatchChanges(batch, lang);
    if (changes.length) return changes.join(", ");
  }
  return getChangeCountLabel(lang, getBatchChangeCount(batch, lang));
}

function activityTimeMs(dateString: string | Date): number {
  try {
    return normalizeTimestamp(dateString as string).getTime();
  } catch {
    return 0;
  }
}

function withinActivityWindow(entry: AuditLog, group: ActivityGroup): boolean {
  return Math.abs(activityTimeMs(group.time) - activityTimeMs(entry.createdAt)) <= 900000;
}

export function SpaceActivityFeed(props: Props) {
  const t = useTranslation();
  const lang = useLocale();

  const merged = mergeProps({ limit: 10 }, props);

  const {
    activities,
    isLoading,
    error,
    getUser,
    getUserName,
    getDocumentName,
    getDocumentHref,
  } = useSpaceActivity(
    () => merged.spaceId,
    lang,
    () => merged.limit,
  );

  const activityGroups = createMemo(() =>
    groupActivityEntries(activities(), withinActivityWindow, lang),
  );

  return (
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-neutral-500 text-size-large leading-large">
          {t("Space Activity")}
        </h2>
      </div>

      <Show when={error()}>
        <div class="rounded-sm border border-red-200 bg-red-50 p-4 text-red-600">
          {error()}
        </div>
      </Show>

      <Show when={!error() && isLoading()}>
        <div class="@container animate-pulse space-y-4">
          <Index each={[1, 2, 3]}>
            {(i) => (
              <>
                <Show when={i() < 2}>
                  <div
                    class="h-4 rounded-sm bg-neutral-100 px-1"
                    classList={{ "w-24": i() === 0, "w-20": i() === 1 }}
                  />
                </Show>

                <div class="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-100 bg-neutral-10">
                  <div class="px-3.5 py-3">
                    <div class="grid min-w-0 @md:grid-cols-[minmax(0,1fr)_minmax(10rem,42%)_auto] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3">
                      <div class="flex min-w-0 items-center gap-3">
                        <div class="h-10 w-10 shrink-0 rounded-full bg-neutral-200" />

                        <div class="min-w-0 space-y-2">
                          <div class="flex items-center gap-2">
                            <div class="h-4 w-20 rounded-sm bg-neutral-200" />
                            <div class="h-4 w-16 rounded-sm bg-neutral-100" />
                          </div>
                          <div class="h-3.5 w-16 rounded-sm bg-neutral-100" />
                        </div>
                      </div>

                      <div class="@md:col-auto col-start-1 @md:row-auto row-start-2 flex min-w-0 items-center gap-3">
                        <Icon
                          class="h-8 w-8 shrink-0 rounded-md bg-neutral-100 p-2 text-neutral-500"
                          name="document"
                        />
                        <div class="h-4 w-32 rounded-sm bg-neutral-100" />
                      </div>

                      <Icon
                        class="@md:col-auto col-start-2 @md:row-auto row-span-2 h-5 w-5 shrink-0 text-neutral-400"
                        name="chevron-right-thin"
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </Index>
        </div>
      </Show>

      <Show when={!error() && !isLoading() && activities().length === 0}>
        <div class="py-8 text-center text-neutral-400">{t("No recent activity")}</div>
      </Show>

      <Show when={!error() && !isLoading() && activities().length > 0}>
        <div class="@container space-y-4">
          <For each={activityGroups()}>
            {(group) => (
              <>
                <Show when={group.showBucket}>
                  <div class="px-1 font-medium text-neutral-500 text-size-small">
                    {group.bucketLabel}
                  </div>
                </Show>

                <div class="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-100 bg-neutral-10">
                  <For each={getCompactActivityBatches(group.items, lang)}>
                    {(batch) => (
                      <a
                        href={
                          batch.isPermission ? undefined : getDocumentHref(batch.docId)
                        }
                        class="block px-3.5 py-3 transition-colors hover:bg-neutral-50"
                      >
                        <div class="grid min-w-0 @md:grid-cols-[minmax(0,1fr)_minmax(10rem,42%)_auto] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3">
                          <div class="flex min-w-0 items-center gap-3">
                            <vektor-avatar
                              size="medium"
                              attr:user-id={group.userId ?? undefined}
                              prop:user={getUser(group.userId)}
                            />

                            <div class="min-w-0">
                              <div class="flex min-w-0 items-baseline gap-1 text-size-medium leading-medium">
                                <span class="font-semibold text-neutral-900">
                                  {getUserName(group.userId)}
                                </span>
                                <span class="shrink-0 text-neutral-700">
                                  {batch.action}
                                </span>
                              </div>
                              <div class="mt-0.5 font-medium text-neutral-500 text-size-small">
                                {getBatchSummary(batch, lang)}
                              </div>
                            </div>
                          </div>

                          <div class="@md:col-auto col-start-1 @md:row-auto row-start-2 flex min-w-0 items-center gap-3">
                            <Icon
                              class="h-8 w-8 shrink-0 rounded-md bg-neutral-100 p-2 text-neutral-500"
                              name={batch.isPermission ? "users" : "document"}
                            />
                            <div class="min-w-0 truncate text-neutral-700 text-size-medium">
                              {batch.isPermission
                                ? t("Members")
                                : getDocumentName(batch.docId)}
                            </div>
                          </div>

                          <Icon
                            class={twMerge(
                              "@md:col-auto col-start-2 @md:row-auto row-span-2 h-5 w-5 shrink-0 text-neutral-400",
                              batch.isPermission && "invisible",
                            )}
                            name="chevron-right-thin"
                          />
                        </div>
                      </a>
                    )}
                  </For>
                </div>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
