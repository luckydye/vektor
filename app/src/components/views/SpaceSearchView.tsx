import { Show } from "solid-js";
import { Search } from "#components/Search.tsx";
import { usePageTitle } from "#composeables/usePageTitle.solid.ts";
import { useSpace } from "#composeables/useSpace.solid.ts";

export function SpaceSearchView() {
  const { currentSpace } = useSpace();

  usePageTitle("Search");

  return (
    <Show when={currentSpace()}>
      {(space) => (
        <inset-view class="block h-full px-xs pt-xs pb-20 md:mr-(--inset-right) md:ml-(--inset-left) lg:px-m lg:pb-8 print:px-0">
          <Search spaceId={space().id} />
        </inset-view>
      )}
    </Show>
  );
}
