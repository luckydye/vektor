import { Show } from "solid-js";
import { Permission } from "#acl/permissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { ArchivedDocuments } from "./ArchivedDocuments.tsx";
import { ExtensionSettings } from "./ExtensionSettings.tsx";
import { JobsSettings } from "./JobsSettings.tsx";
import { SettingsLayout } from "./SettingsLayout.tsx";
import { SettingsSection } from "./SettingsSection.tsx";
import { SpaceGeneralSettings } from "./SpaceGeneralSettings.tsx";
import { SpaceSecretsSettings } from "./SpaceSecretsSettings.tsx";

const tabs = [
  { id: "general", label: "General" },
  { id: "integrations", label: "Integrations" },
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
