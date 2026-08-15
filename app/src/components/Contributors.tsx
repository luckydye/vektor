import { createMemo, For, mergeProps, Show } from "solid-js";
import { useActiveCollaboration } from "#composeables/useCollaboration.ts";
import { useContributors } from "#composeables/useContributors.ts";
import { useViewTransitionList } from "#composeables/useViewTransitionList.ts";
import type { PublicUserAppearance } from "#cosmetics/types.ts";
import { viewTransitionName } from "#utils/viewTransition.ts";
import "./AvatarElement.ts";
import "@atrium-ui/elements/popover";

interface Props {
  documentId?: string;
  max?: number;
}

interface Collaborator {
  key: string;
  user: {
    name: string;
    image?: string | null;
    appearance?: PublicUserAppearance;
  };
  isPresent: boolean;
  isCollaborator: boolean;
}

export function Contributors(props: Props) {
  const merged = mergeProps({ max: 5 }, props);

  const collaboration = useActiveCollaboration();
  const { contributors } = useContributors(props.documentId);

  const collaborators = createMemo(() => {
    const collaboratorsByUser = new Map<string, Collaborator>();

    for (const contributor of contributors()) {
      collaboratorsByUser.set(contributor.userId, {
        key: contributor.userId,
        user: contributor,
        isPresent: false,
        isCollaborator: true,
      });
    }

    for (const profile of collaboration()?.roomPresenceProfiles() ?? []) {
      const key = profile.user.id || profile.clientId;
      const contributor = collaboratorsByUser.get(key);

      collaboratorsByUser.set(key, {
        key,
        user: contributor
          ? {
              ...contributor.user,
              ...profile.user,
            }
          : profile.user,
        isPresent: true,
        isCollaborator: contributor?.isCollaborator ?? false,
      });
    }

    return [...collaboratorsByUser.values()].sort(
      (left, right) => Number(right.isPresent) - Number(left.isPresent),
    );
  });

  const displayCollaborators = createMemo(() => collaborators().slice(0, merged.max));

  const visibleAvatars = useViewTransitionList(
    displayCollaborators,
    (collaborator) => collaborator.key,
  );

  const remainingCount = createMemo(() =>
    Math.max(0, collaborators().length - merged.max),
  );

  const actualCollaborators = createMemo(() =>
    collaborators().filter((collaborator) => collaborator.isCollaborator),
  );
  const visibleRows = useViewTransitionList(
    actualCollaborators,
    (collaborator) => collaborator.key,
  );

  return (
    <Show when={collaborators().length > 0}>
      <a-popover-trigger
        showdelay="200"
        hidedelay="100"
        class="group relative z-20 block"
      >
        <button
          slot="trigger"
          type="button"
          class="flex items-center"
          data-tooltip="Collaborators"
          data-tooltip-pos="bottom"
        >
          <span class="flex items-center">
            <For each={visibleAvatars()}>
              {(collaborator, index) => (
                <span
                  class="relative block"
                  classList={{ "z-10": collaborator.isPresent }}
                  style={{
                    "margin-left": index() > 0 ? "-8px" : "0",
                    "z-index": String(visibleAvatars().length - index()),
                    "view-transition-name": viewTransitionName(
                      "vt-collab",
                      collaborator.key,
                    ),
                  }}
                  title={collaborator.user.name}
                >
                  <span
                    class="block rounded-full transition-shadow duration-200"
                    classList={{
                      "ring-2 ring-green-500 ring-offset-1 ring-offset-background":
                        collaborator.isPresent,
                    }}
                  >
                    <vektor-avatar
                      size="small"
                      attr:user-id={collaborator.key}
                      prop:user={collaborator.user}
                    />
                  </span>
                </span>
              )}
            </For>
          </span>
          <Show when={remainingCount() > 0}>
            <div
              class="relative flex items-center justify-center rounded-full border-2 border-background bg-primary-100 font-medium text-label text-primary-400"
              style={{
                width: "32px",
                height: "32px",
                "margin-left": "-8px",
                "z-index": "0",
              }}
            >
              +{remainingCount()}
            </div>
          </Show>
        </button>

        <a-popover class="group" placements="bottom">
          <div class="my-3xs w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
            <a-popover-arrow>
              <div class="contributors-arrow" />
            </a-popover-arrow>
            <div class="flex min-w-[200px] flex-col gap-1 rounded-lg border border-neutral-100 bg-neutral-10 p-4xs shadow-large">
              <div class="px-4xs font-medium text-neutral-600 text-size-small">
                Collaborators
              </div>
              <div class="flex max-h-[240px] flex-col overflow-y-auto">
                <For each={visibleRows()}>
                  {(collaborator) => (
                    <div
                      class="flex items-center gap-3xs rounded-md px-4xs py-4xs"
                      style={{
                        "view-transition-name": viewTransitionName(
                          "vt-collab-row",
                          collaborator.key,
                        ),
                      }}
                    >
                      <div class="relative">
                        <vektor-avatar
                          size="small"
                          attr:user-id={collaborator.key}
                          prop:user={collaborator.user}
                        />
                      </div>
                      <span class="min-w-0 flex-1 truncate text-interactive text-neutral-950">
                        {collaborator.user.name}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        </a-popover>
      </a-popover-trigger>
    </Show>
  );
}
