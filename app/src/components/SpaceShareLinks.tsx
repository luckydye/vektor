import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { ShareLink } from "#api/client.ts";
import { api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import { formatAbsoluteDate } from "#utils/dateFormat.ts";
import { Icon } from "./Icon.tsx";

type ShareLinkStatus = "active" | "expired" | "revoked";

function linkStatus(link: ShareLink): ShareLinkStatus {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) {
    return "expired";
  }
  return "active";
}

function statusClass(status: ShareLinkStatus): string {
  if (status === "active") return "bg-green-100 text-green-700";
  if (status === "expired") return "bg-yellow-100 text-yellow-700";
  return "bg-neutral-100 text-neutral-500";
}

export function SpaceShareLinks() {
  const t = useTranslation();
  const lang = useLocale();
  const { currentSpace, currentSpaceId } = useSpace();
  const [links, setLinks] = createSignal<ShareLink[]>([]);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = createSignal<string | null>(null);
  const [revokingLinkId, setRevokingLinkId] = createSignal<string | null>(null);

  const activeCount = createMemo(
    () => links().filter((link) => linkStatus(link) === "active").length,
  );

  async function loadLinks() {
    const spaceId = currentSpaceId();
    if (!spaceId) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.shares.get(spaceId);
      setLinks(response.links);
    } catch (err) {
      setLinks([]);
      setError(err instanceof Error ? err.message : t("Failed to load share links"));
    } finally {
      setIsLoading(false);
    }
  }

  createEffect(
    on(currentSpaceId, (spaceId) => {
      if (spaceId) void loadLinks();
    }),
  );

  function linkUrl(link: ShareLink): string {
    return `${window.location.origin}/${currentSpace()?.slug}/s/${link.id}`;
  }

  async function copyLink(link: ShareLink) {
    try {
      await navigator.clipboard.writeText(linkUrl(link));
      setCopiedLinkId(link.id);
      setTimeout(
        () => setCopiedLinkId((current) => (current === link.id ? null : current)),
        1_500,
      );
    } catch {
      setError(t("Could not copy the link"));
    }
  }

  async function revokeLink(link: ShareLink) {
    const spaceId = currentSpaceId();
    if (
      !spaceId ||
      !confirm(t("Revoke this link? Anyone holding it loses access."))
    ) {
      return;
    }

    setRevokingLinkId(link.id);
    setError(null);
    try {
      await api.shares.revoke(spaceId, link.id);
      await loadLinks();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Failed to revoke link"));
    } finally {
      setRevokingLinkId(null);
    }
  }

  function scopeLabel(link: ShareLink): string {
    return link.resourceType === "document_tree"
      ? t("Page and child pages")
      : t("Page only");
  }

  function statusLabel(status: ShareLinkStatus): string {
    if (status === "active") return t("Active");
    if (status === "expired") return t("Expired");
    return t("Revoked");
  }

  function documentUrl(link: ShareLink): string | undefined {
    const space = currentSpace();
    return space && link.resource
      ? `/${space.slug}/doc/${link.resource.slug}`
      : undefined;
  }

  return (
    <section>
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="font-semibold text-neutral-900 text-size-large">
            {t("Share links")}
          </h2>
          <p class="mt-1 text-neutral-500 text-size-small">
            {t("Review every read-only link created for pages in this space.")}
          </p>
        </div>
        <Show when={!isLoading() && links().length > 0}>
          <span class="whitespace-nowrap text-neutral-500 text-size-small">
            {t("{count} active").replace("{count}", String(activeCount()))}
          </span>
        </Show>
      </div>

      <Show when={error()}>
        <div class="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-600 text-size-small">
          <div class="flex items-center justify-between gap-3">
            <span>{error()}</span>
            <button type="button" class="underline" onClick={() => void loadLinks()}>
              {t("Try again")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={isLoading()}>
        <div class="flex justify-center py-8">
          <div class="h-6 w-6 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
        </div>
      </Show>

      <Show when={!isLoading() && links().length > 0}>
        <div class="mt-3 overflow-x-auto rounded-md border border-neutral-100">
          <table class="min-w-full text-size-medium">
            <thead class="bg-neutral-50">
              <tr>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  {t("Page")}
                </th>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  {t("Scope")}
                </th>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  {t("Status")}
                </th>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  {t("Activity")}
                </th>
                <th class="px-4 py-2.5 text-right font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  {t("Actions")}
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              <For each={links()}>
                {(link) => {
                  const status = () => linkStatus(link);
                  return (
                    <tr class="hover:bg-neutral-50">
                      <td class="px-4 py-2.5">
                        <div class="flex items-center gap-3">
                          <span class="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-neutral-100 text-neutral-500">
                            <Icon
                              class="h-3.5 w-3.5"
                              name={link.hasPassword ? "lock-element" : "link"}
                            />
                          </span>
                          <div class="min-w-0">
                            <Show
                              when={documentUrl(link)}
                              fallback={
                                <div class="max-w-72 truncate font-medium text-neutral-900">
                                  {link.resource?.title || link.name || t("Untitled")}
                                </div>
                              }
                            >
                              {(url) => (
                                <a
                                  href={url()}
                                  class="block max-w-72 truncate font-medium text-neutral-900 hover:underline"
                                >
                                  {link.resource?.title || link.name || t("Untitled")}
                                </a>
                              )}
                            </Show>
                            <div class="text-neutral-500 text-size-small">
                              {link.resource?.archived
                                ? t("Archived page")
                                : link.hasPassword
                                  ? t("Password protected")
                                  : t("No password")}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5 text-neutral-600">
                        {scopeLabel(link)}
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5">
                        <span
                          class={`inline-flex rounded-full px-2 py-0.5 font-medium text-size-small ${statusClass(status())}`}
                        >
                          {statusLabel(status())}
                        </span>
                        <Show when={link.expiresAt && status() !== "revoked"}>
                          <div class="mt-0.5 text-neutral-500 text-size-small">
                            {t("Expires {date}").replace(
                              "{date}",
                              formatAbsoluteDate(link.expiresAt as Date | string, lang),
                            )}
                          </div>
                        </Show>
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5 text-neutral-600">
                        {link.lastUsedAt
                          ? t("Opened {date}").replace(
                              "{date}",
                              formatAbsoluteDate(link.lastUsedAt, lang),
                            )
                          : t("Never opened")}
                      </td>
                      <td class="space-x-3 whitespace-nowrap px-4 py-2.5 text-right">
                        <Show when={status() === "active"}>
                          <button
                            type="button"
                            class="text-neutral-600 text-size-small hover:text-neutral-900"
                            onClick={() => void copyLink(link)}
                          >
                            {copiedLinkId() === link.id ? t("Copied") : t("Copy")}
                          </button>
                          <button
                            type="button"
                            disabled={revokingLinkId() === link.id}
                            class="text-red-600 text-size-small hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => void revokeLink(link)}
                          >
                            {revokingLinkId() === link.id ? t("Revoking…") : t("Revoke")}
                          </button>
                        </Show>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={!isLoading() && !error() && links().length === 0}>
        <div class="mt-3 rounded-lg border border-neutral-100 py-10 text-center">
          <Icon class="mx-auto h-10 w-10 text-neutral-300" name="link" />
          <p class="mt-3 text-neutral-500 text-size-small">
            {t("No share links have been created in this space.")}
          </p>
        </div>
      </Show>
    </section>
  );
}
