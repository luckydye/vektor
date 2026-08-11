import { createMemo, Show } from "solid-js";
import { canAccessSettings } from "#acl/permissions.ts";
import { NoAccess } from "#components/NoAccess.tsx";
import { SpaceSettings } from "#components/SpaceSettings.tsx";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";

export function SpaceSettingsView() {
  const { currentSpace } = useSpace();
  const isOwner = createMemo(() => canAccessSettings(currentSpace()?.userRole));

  usePageTitle("Settings");

  return (
    <Show when={currentSpace()}>
      <inset-view class="block h-full px-xs pt-xs pb-20 md:mr-(--inset-right) md:ml-(--inset-left) lg:px-m lg:pb-8 print:px-0">
        <Show when={isOwner()} fallback={<NoAccess />}>
          <SpaceSettings />
        </Show>
      </inset-view>
    </Show>
  );
}
