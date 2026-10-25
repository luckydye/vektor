import { For, Show } from "solid-js";
import type { NodeSummary } from "#agent/nodes/protocol.ts";

interface Props {
  /** Undefined while loading. */
  nodes: NodeSummary[] | undefined;
}

/** The devices the user's agents and chats can run on. */
export function SpaceNodes(props: Props) {
  return (
    <Show
      when={props.nodes?.length}
      fallback={
        <div class="rounded-xl border border-neutral-200 bg-neutral-50 p-5 text-neutral-500 text-size-small">
          <Show when={props.nodes} fallback="Loading…">
            No nodes are connected. Run <code>vektor agent serve</code> on a device logged
            in to this space with <code>vektor login</code>.
          </Show>
        </div>
      }
    >
      <ul class="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-background">
        <For each={props.nodes}>
          {(node) => (
            <li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span
                    class={`h-2 w-2 shrink-0 rounded-full ${node.online ? "bg-primary-500" : "bg-neutral-300"}`}
                    title={node.online ? "Online" : "Offline"}
                  />
                  <span class="truncate font-medium text-neutral-900 text-size-medium">
                    {node.name}
                  </span>
                </div>
                <p class="mt-0.5 truncate text-neutral-500 text-size-small">
                  {node.os} · {node.workdir}
                </p>
              </div>
              <div class="text-right text-neutral-500 text-size-small">
                <p>
                  {node.running} / {node.maxSessions} sessions
                </p>
                <p>{node.adapters.join(", ")}</p>
              </div>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
