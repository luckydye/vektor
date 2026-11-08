export const DOCS_NAVIGATION = [
  {
    title: "Documentation",
    links: [
      { href: "/docs", label: "Overview" },
      { href: "/docs/api", label: "API" },
      { href: "/docs/permissions", label: "Permissions" },
      { href: "/docs/extensions", label: "Extensions" },
    ],
  },
];

/** The markdown-backed docs pages, by the section name in their URL. */
export const DOCS_SECTIONS = {
  api: "API - Vektor",
  permissions: "Permissions - Vektor",
  extensions: "Extensions - Vektor",
} as const;

export type DocsSection = keyof typeof DOCS_SECTIONS;

export function isDocsSection(value: string): value is DocsSection {
  return Object.hasOwn(DOCS_SECTIONS, value);
}
