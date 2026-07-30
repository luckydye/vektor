<template>
  <SettingsLayout :tabs="tabs" :initial-tab="tabFromHash()" @tab-change="setTab">
    <template #general>
      <SpaceGeneralSettings />
    </template>

    <template #integrations>
      <section>
        <h2 class="text-size-large font-semibold text-neutral-900 mb-4">Extensions</h2>
        <p class="text-size-medium text-neutral-900 mt-1">
          Install and manage extensions to add functionality
        </p>
        <ExtensionSettings />

        <SpaceSecretsSettings />
      </section>

      <SpaceAccessTokensSettings />
    </template>

    <!-- Agent -->
    <template #agent>
      <section>
        <AgentSettings />
      </section>
    </template>

    <!-- Jobs -->
    <template #jobs>
      <section>
        <h2 class="text-size-large font-semibold text-neutral-900 mb-4">
          Jobs & Workflows
        </h2>
        <JobsSettings />
      </section>
    </template>

    <!-- Archive -->
    <template #archive>
      <section>
        <h2 class="text-size-large font-semibold text-neutral-900 mb-4 mt-2">
          Archived Documents
        </h2>
        <ArchivedDocuments v-if="currentSpace" :space-id="currentSpace.id" />
      </section>
    </template>
  </SettingsLayout>
</template>

<script setup lang="ts">
import AgentSettings from "./AgentSettings.vue";
import ArchivedDocuments from "./ArchivedDocuments.vue";
import ExtensionSettings from "./ExtensionSettings.vue";
import JobsSettings from "./JobsSettings.vue";
import SettingsLayout from "./SettingsLayout.vue";
import SpaceAccessTokensSettings from "./SpaceAccessTokensSettings.vue";
import SpaceGeneralSettings from "./SpaceGeneralSettings.vue";
import SpaceSecretsSettings from "./SpaceSecretsSettings.vue";

const tabs = [
  { id: "general", label: "General" },
  { id: "integrations", label: "Integrations" },
  { id: "agent", label: "Agent" },
  { id: "jobs", label: "Workflows" },
  { id: "archive", label: "Archive" },
] as const;

type TabId = (typeof tabs)[number]["id"];
const validTabIds = tabs.map((t) => t.id) as string[];

function tabFromHash(): TabId {
  if (typeof window === "undefined") return "general";
  const hash = window.location.hash.slice(1);
  return validTabIds.includes(hash) ? (hash as TabId) : "general";
}

function setTab(id: string) {
  window.location.hash = id;
}
</script>
