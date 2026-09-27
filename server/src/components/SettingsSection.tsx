import { type JSX, Show } from "solid-js";

interface Props {
  title: string;
  description?: string;
  /** Header controls, placed under the description. */
  actions?: JSX.Element;
  children: JSX.Element;
}

export function SettingsSection(props: Props) {
  return (
    <section class="@container border-neutral-100 border-t py-8 first:border-t-0 first:pt-0">
      <div class="grid @3xl:grid-cols-[18rem_minmax(0,1fr)] @3xl:gap-12 gap-4">
        <div>
          <h2 class="font-semibold text-neutral-900 text-size-large">{props.title}</h2>
          <Show when={props.description}>
            <p class="mt-1 text-neutral-500 text-size-small">{props.description}</p>
          </Show>
          <Show when={props.actions}>
            <div class="mt-3">{props.actions}</div>
          </Show>
        </div>
        <div class="@container min-w-0">{props.children}</div>
      </div>
    </section>
  );
}
