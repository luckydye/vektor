import { Show } from "solid-js";
import { Permission } from "#acl/permissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { AgentSettings } from "./AgentSettings.tsx";
import { ArchivedDocuments } from "./ArchivedDocuments.tsx";
import { ExtensionSettings } from "./ExtensionSettings.tsx";
import { JobsSettings } from "./JobsSettings.tsx";
import { SettingsLayout } from "./SettingsLayout.tsx";
import { SpaceAccessTokensSettings } from "./SpaceAccessTokensSettings.tsx";
import { SpaceGeneralSettings } from "./SpaceGeneralSettings.tsx";
import { SpaceSecretsSettings } from "./SpaceSecretsSettings.tsx";

const tabs = [
  { id: "general", label: "General" },
  { id: "integrations", label: "Integrations" },
  { id: "agent", label: "Agent" },
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
        general: () => (
          <>
            <section>
              <h2 class="mb-3 font-semibold text-neutral-900 text-size-large">
                Space Settings
              </h2>
              <p class="mt-1 text-neutral-900 text-size-medium">
                Personalize your space with settings and preferences.
              </p>
              <div class="pt-6">
                <SpaceGeneralSettings />
              </div>
            </section>
          </>
        ),
        integrations: () => (
          <>
            <section>
              <h2 class="mb-3 font-semibold text-neutral-900 text-size-large">
                Extensions
              </h2>
              <p class="mt-1 text-neutral-900 text-size-medium">
                Install and manage extensions to add functionality
              </p>
              <ExtensionSettings />

              <Show when={currentSpace()?.userRole === Permission.OWNER}>
                <SpaceSecretsSettings />
              </Show>
            </section>

            <SpaceAccessTokensSettings />
          </>
        ),
        agent: () => (
          <section>
            <AgentSettings />
          </section>
        ),
        jobs: () => (
          <section>
            <h2 class="mb-4 font-semibold text-neutral-900 text-size-large">
              Jobs &amp; Workflows
            </h2>
            <JobsSettings />
          </section>
        ),
        archive: () => (
          <section>
            <h2 class="mt-2 mb-4 font-semibold text-neutral-900 text-size-large">
              Archived Documents
            </h2>
            <Show when={currentSpace()}>
              {(space) => <ArchivedDocuments spaceId={space().id} />}
            </Show>
          </section>
        ),
      }}
    />
  );
}
