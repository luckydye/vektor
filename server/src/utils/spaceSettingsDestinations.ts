/**
 * The places in space settings a link can point at: each tab, and the sections
 * within them worth jumping to. Addressed by URL hash — `/settings#runners` —
 * so a section id also selects the tab it sits in.
 */

export const SPACE_SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "integrations", label: "Integrations" },
  { id: "ai", label: "AI" },
  { id: "jobs", label: "Workflows" },
  { id: "archive", label: "Archive" },
] as const;

export type SpaceSettingsTab = (typeof SPACE_SETTINGS_TABS)[number]["id"];

export interface SpaceSettingsDestination {
  /** The URL hash: a tab id, or the id of a section within `tab`. */
  id: string;
  tab: SpaceSettingsTab;
  /** As the command palette lists it. */
  title: string;
  description: string;
  /** Shown to space owners only, as its section is. */
  ownerOnly?: boolean;
}

export const SPACE_SETTINGS_DESTINATIONS: readonly SpaceSettingsDestination[] = [
  {
    id: "general",
    tab: "general",
    title: "Space Settings",
    description: "Name, description, logo and colour of the space",
  },
  {
    id: "features",
    tab: "general",
    title: "Features",
    description: "Which document types members can create",
  },
  {
    id: "access",
    tab: "general",
    title: "Members & Access",
    description: "Members, groups and tokens with access to the space",
  },
  {
    id: "share-links",
    tab: "general",
    title: "Share Links",
    description: "Read-only links created for pages in the space",
  },
  {
    id: "danger-zone",
    tab: "general",
    title: "Delete Space",
    description: "Danger zone",
  },
  {
    id: "extensions",
    tab: "integrations",
    title: "Extensions",
    description: "Install and manage extensions",
  },
  {
    id: "secrets",
    tab: "integrations",
    title: "Secrets",
    description: "Values workflows and extensions can read",
    ownerOnly: true,
  },
  {
    id: "ai",
    tab: "ai",
    title: "AI Usage",
    description: "Token usage and the weekly AI budget",
    ownerOnly: true,
  },
  {
    id: "runners",
    tab: "ai",
    title: "AI Runners",
    description: "Where jobs, workflows and agents run",
    ownerOnly: true,
  },
  {
    id: "jobs",
    tab: "jobs",
    title: "Scheduled Workflows",
    description: "Workflows that run on a schedule",
  },
  {
    id: "workflow-runs",
    tab: "jobs",
    title: "Workflow Runs",
    description: "The latest runs across all workflows",
  },
  {
    id: "archive",
    tab: "archive",
    title: "Archive",
    description: "Restore or delete archived documents",
  },
];

/** The tab a settings hash opens, and the section to scroll to when it names one. */
export function resolveSpaceSettingsHash(hash: string): {
  tab: SpaceSettingsTab;
  section?: string;
} {
  const id = hash.replace(/^#/, "");
  // A tab's own id opens it, whether or not a destination is listed under that
  // name: `integrations` has none, since its sections are listed individually.
  const tab = SPACE_SETTINGS_TABS.find((entry) => entry.id === id);
  if (tab) return { tab: tab.id };
  const destination = SPACE_SETTINGS_DESTINATIONS.find((entry) => entry.id === id);
  if (!destination) return { tab: "general" };
  return destination.id === destination.tab
    ? { tab: destination.tab }
    : { tab: destination.tab, section: destination.id };
}
