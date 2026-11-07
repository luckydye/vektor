import { useLocation, useNavigate } from "@solidjs/router";
import { createMemo, Show } from "solid-js";
import { Permission } from "#acl/permissions.ts";
import { useRunners } from "#composeables/useRunners.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { ArchivedDocuments } from "./ArchivedDocuments.tsx";
import { ExtensionSettings } from "./ExtensionSettings.tsx";
import { JobsSettings } from "./JobsSettings.tsx";
import { SettingsLayout } from "./SettingsLayout.tsx";
import { SettingsSection } from "./SettingsSection.tsx";
import { SpaceAIUsage } from "./SpaceAIUsage.tsx";
import { SpaceGeneralSettings } from "./SpaceGeneralSettings.tsx";
import { SpaceRunners } from "./SpaceRunners.tsx";
import { SpaceSecretsSettings } from "./SpaceSecretsSettings.tsx";
import {
  resolveSpaceSettingsHash,
  SPACE_SETTINGS_TABS,
} from "#utils/spaceSettingsDestinations.ts";

export function SpaceSettings() {
  const { currentSpace } = useSpace();
  const isOwner = createMemo(() => currentSpace()?.userRole === Permission.OWNER);
  const runners = useRunners(isOwner);
  // From the router, so a jump into settings while already here switches tabs.
  const location = useLocation();
  const navigate = useNavigate();
  const target = createMemo(() => resolveSpaceSettingsHash(location.hash));

  return (
    <SettingsLayout
      tabs={SPACE_SETTINGS_TABS}
      activeTab={target().tab}
      activeSection={target().section}
      onTabChange={(id) => navigate(`${location.pathname}${location.search}#${id}`)}
      panels={{
        general: () => <SpaceGeneralSettings />,
        integrations: () => (
          <>
            <SettingsSection
              id="extensions"
              title="Extensions"
              description="Install and manage extensions to add functionality."
            >
              <ExtensionSettings />
            </SettingsSection>
            <Show when={currentSpace()?.userRole === Permission.OWNER}>
              <SpaceSecretsSettings />
            </Show>
          </>
        ),
        ai: () => (
          <Show
            when={isOwner()}
            fallback={
              <p class="text-neutral-500 text-size-small">
                Only space owners manage AI usage and runners.
              </p>
            }
          >
            <SpaceAIUsage />
            <SettingsSection
              id="runners"
              title="Runners"
              description="Where this space's jobs, workflows and your agents can run instead of the server."
            >
              <SpaceRunners
                nodes={runners.nodes()}
                runners={runners.runners()}
                onAdd={runners.add}
                onDescribe={runners.describe}
                onRemove={runners.remove}
              />
            </SettingsSection>
          </Show>
        ),
        jobs: () => <JobsSettings />,
        archive: () => (
          <SettingsSection
            id="archived-documents"
            title="Archived Documents"
            description="Restore or permanently delete archived documents."
          >
            <Show when={currentSpace()}>
              {(space) => <ArchivedDocuments spaceId={space().id} />}
            </Show>
          </SettingsSection>
        ),
      }}
    />
  );
}
