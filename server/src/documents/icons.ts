import type { IconName } from "#components/Icon.tsx";

/* Types come from the documents in the space, so an extension can introduce one
 * this map has never heard of — hence the generic fallback. */
const documentTypeIcons: Readonly<Record<string, IconName>> = {
  app: "extension",
  canvas: "canvas",
  csv: "csv-file",
  database: "database",
  document: "document",
  file: "file",
  markdown: "markdown",
  record: "record",
  repository: "repository",
  workflow: "bolt",
};

export function documentTypeIcon(type: string | null | undefined): IconName {
  return documentTypeIcons[type ?? "document"] ?? "document";
}
