/** Keys for settings that apply to an entire space. */
export const spacePreferenceKeys = {
  workflowCreationEnabled: "workflowCreationEnabled",
} as const;

/**
 * Workflows remain available for spaces created before this preference existed.
 * Only an explicit false value disables creating new workflow documents.
 */
export function isWorkflowCreationEnabled(
  preferences: Record<string, string> | null | undefined,
): boolean {
  return preferences?.[spacePreferenceKeys.workflowCreationEnabled] !== "false";
}
