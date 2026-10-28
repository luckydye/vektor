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

const tabs = [
  { id: "general", label: "General" },
  { id: "integrations", label: "Integrations" },
  { id: "ai", label: "AI" },
  { id: "jobs", label: "Workflows" },
  { id: "archive", label: "Archive" },
] as const;

type TabId = (typeof tabs)[number]["id"];
const validTabIds = tabs.map((tab) => tab.id) as string[];

function tabFromHash(): TabId {
  if (typeof window === "undefined") return "general";
  const hash = window.location.hash.slice(1);
  return validTabIds.includes(hash) ? (hash as TabId) : "general";
}

function setTab(id: string) {
  window.location.hash = id;
}

export function SpaceSettings() {
  const { currentSpace } = useSpace();
  const isOwner = createMemo(() => currentSpace()?.userRole === Permission.OWNER);
  const runners = useRunners(isOwner);

  return (
    <SettingsLayout
      tabs={tabs}
      initialTab={tabFromHash()}
      onTabChange={setTab}
      panels={{
        general: () => <SpaceGeneralSettings />,
        integrations: () => (
          <>
            <SettingsSection
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
