import { Show } from "solid-js";
import { Search } from "#components/Search.tsx";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";

export function SpaceSearchView() {
  const { currentSpace } = useSpace();

  usePageTitle("Search");

  // No `pt-*` on the view: the sticky search bar carries the top gutter itself.
  return (
    <Show when={currentSpace()}>
      {(space) => (
        <inset-view class="block h-full px-xs pb-20 md:mr-(--inset-right) md:ml-(--inset-left) lg:px-m lg:pb-8 print:px-0">
          <Search spaceId={space().id} />
        </inset-view>
      )}
    </Show>
  );
}
