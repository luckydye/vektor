import { createMemo, Show } from "solid-js";
import { Permission } from "#acl/permissions.ts";
import { useJobRunners } from "#composeables/useJobRunners.ts";
import { useNodes } from "#composeables/useNodes.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { ArchivedDocuments } from "./ArchivedDocuments.tsx";
import { ExtensionSettings } from "./ExtensionSettings.tsx";
import { JobsSettings } from "./JobsSettings.tsx";
import { SettingsLayout } from "./SettingsLayout.tsx";
import { SettingsSection } from "./SettingsSection.tsx";
import { SpaceAIUsage } from "./SpaceAIUsage.tsx";
import { SpaceGeneralSettings } from "./SpaceGeneralSettings.tsx";
import { SpaceJobRunners } from "./SpaceJobRunners.tsx";
import { SpaceNodes } from "./SpaceNodes.tsx";
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
  const nodes = useNodes(isOwner);
  const jobRunners = useJobRunners(isOwner);

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
                Only space owners manage AI usage and nodes.
              </p>
            }
          >
            <SpaceAIUsage />
            <SettingsSection
              title="Nodes"
              description="Your devices that agents, chats and jobs can run on. Only space owners can connect one."
            >
              <SpaceNodes nodes={nodes()} />
            </SettingsSection>
            <SettingsSection
              title="Job runners"
              description="Endpoints that run this space's jobs and workflows instead of the server."
            >
              <SpaceJobRunners
                runners={jobRunners.runners()}
                onAdd={jobRunners.add}
                onRemove={jobRunners.remove}
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
