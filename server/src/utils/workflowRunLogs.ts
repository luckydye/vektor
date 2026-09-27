/** The series a workflow run logs to, one `workflow.log` point per line. */
export function workflowRunSeriesName(runId: string): string {
  return `workflow-run:${runId}`;
}

interface RunLogSource {
  runId: string;
  createdAt: string;
}

/** Every log line of a run, read through the API with `getJson`. */
export async function readWorkflowRunLogLines(
  getJson: (path: string) => Promise<unknown>,
  spaceId: string,
  run: RunLogSource,
): Promise<string[]> {
  const name = encodeURIComponent(workflowRunSeriesName(run.runId));
  const query = new URLSearchParams({
    from: String(Date.parse(run.createdAt)),
    to: String(Date.now() + 60_000),
    limit: "10000",
  });
  const lines: string[] = [];
  for (;;) {
    const page = (await getJson(
      `/api/v1/spaces/${spaceId}/series/${name}/points?${query}`,
    )) as { points: Array<{ fields: { message?: unknown } }>; nextCursor: string | null };
    lines.push(...page.points.map((point) => String(point.fields.message)));
    if (!page.nextCursor) return lines;
    query.set("cursor", page.nextCursor);
  }
}
