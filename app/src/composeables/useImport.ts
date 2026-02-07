import { ref } from "vue";
import { api } from "../api/client.ts";

export interface ImportResult {
  totalFiles: number;
  imported: number;
  skipped: number;
  failed: number;
  documents: Array<{ slug: string; title: string; id: string }>;
  errors: Array<{ file: string; error: string }>;
}

export function useImport() {
  const importing = ref(false);
  const progress = ref<ImportResult | null>(null);
  const error = ref<string | null>(null);

  /**
   * Import WIF (Wiki Interchange Format) files into a space
   *
   * WIF is a standardized format for importing documents with metadata,
   * hierarchy, and media attachments.
   *
   * Supported format: WIF ZIP archives only (.wif.zip or .zip)
   *
   * Use `bun scripts/convert-xwiki-to-wif.ts` to convert XWiki exports to WIF format.
   *
   * WIF Structure:
   * ```
   * export-name.wif.zip
   * ├── wif.json              # Manifest file
   * ├── documents/            # Markdown documents with YAML frontmatter
   * │   ├── index.md
   * │   └── path/
   * │       └── to/
   * │           └── document.md
   * └── media/                # Attachments and images
   *     └── path/
   *         └── to/
   *             └── image.png
   * ```
   *
   * @example
   * const { importFiles } = useImport();
   *
   * // Import a WIF archive
   * const wifFile = fileInput.files[0];
   * const result = await importFiles('space-123', wifFile);
   *
   * @param spaceId - The space ID to import into
   * @param file - WIF zip file to import
   * @returns Import result with statistics and created documents
   */
  async function importFiles(spaceId: string, file: File): Promise<ImportResult> {
    importing.value = true;
    error.value = null;
    progress.value = null;

    try {
      const result = (await api.import.post(spaceId, file)) as ImportResult;
      progress.value = result;
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error occurred";
      error.value = errorMessage;
      throw err;
    } finally {
      importing.value = false;
    }
  }

  /**
   * Reset the import state
   */
  function resetImport() {
    importing.value = false;
    progress.value = null;
    error.value = null;
  }

  return {
    importing,
    progress,
    error,
    importFiles,
    resetImport,
  };
}
