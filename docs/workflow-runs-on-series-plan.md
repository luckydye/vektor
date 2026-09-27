# Workflow runs on the series API

**Runs and their logs become points in one space series, `workflow-runs`.**
Retention is the series' own prune, so run history expires without a job of its
own. Nothing about a run is kept in SQLite; a document is made from a run only
when someone asks for one.

Replaces the hidden `workflow-run` child documents, their `_workflowRun*`
properties, and the per-run `workflow-run:{runId}` log series (whose catalog rows
are never pruned, so they grow by one per run forever).

## Decisions

- **Space-level access.** Reading runs needs `VIEWER` on the space, starting or
  cancelling needs `EDITOR`. The per-workflow-document filter in the run routes
  goes away.
- **No per-run deletes.** A run disappears when its window passes retention.
- **In-flight state lives in `activeRuns`.** The series holds what a run
  *was*; memory holds what an active run *is*.
- **No backfill.** Existing run documents and per-run series are deleted.

## Series

One series per space, declared idempotently on the first run:

| | |
| --- | --- |
| name | `workflow-runs` |
| kind | `log` |
| documentId | `null` (space-owned) |
| retentionDays | `VEKTOR_WORKFLOW_RUN_RETENTION_DAYS` (30; replaces `_LOG_RETENTION_DAYS`) |

### Points

| type | ts | fields |
| --- | --- | --- |
| `workflow.run` | run `createdAt` | `runId`, `documentId`, `status`, `sourceExtensionId`, `initiatedByUserId`, `inputs` (summarized JSON), `error`, `hasResult`, `startedAt`, `completedAt` |
| `workflow.log` | line time | `runId`, `level`, `message` |

- A `workflow.run` point is a full snapshot. One is written on create
  (`pending`) and one on the terminal transition. `running`, errors and results
  in between exist only in `activeRuns`.
- **Every `workflow.run` point of a run uses the run's `createdAt` as `ts`.**
  All of a run's snapshots then share one window, and the order within the same
  `ts` is arrival, so newest-first returns the latest snapshot first. The
  terminal point is a late point in that window, which the store already handles
  (new segment, dirty window).
- Field values are scalars, so `inputs` is a JSON string and times are ms
  numbers.

### Run ids

`run_{createdAtMs}_{uuid}` (a new `run` prefix in `#db/ids.ts`). The id holds the
window, so reading a run by id reads one window, not the whole retention range.

## Reads

- **Run by id** (`getRunForRead`): `activeRuns`, else
  `readSeriesPoints({ from: ts, to: ts + 1, where: [type = workflow.run, runId = id], order: "desc", limit: 1 })`.
- **Run list**: `order: "desc"` over `[now − retention, now]`, where
  `type = workflow.run` plus optional `documentId` / `sourceExtensionId`
  predicates. The cursor is the series cursor. Filtering moves into `where`, which
  fixes the short pages the post-pagination `sourceExtensionId` filter gives
  today.
- **Dedupe by `runId`, first occurrence wins.** A run's create and terminal
  snapshots can land on either side of a page boundary. The route dedupes within
  a page, and the client dedupes across pages.
- **Derived status.** The newest snapshot is `pending` and the run is not in
  `activeRuns` → reported as `failed` with `RUN_STORE_RECOVERY_ERROR`. This
  replaces `recoverSpace` / `ensureSpaceRecovered` and their write-back.
- **Active runs overlay** the stored snapshot, as `listRuns` does now.
- **Run logs**: `from: createdAt` (from the id), where `type = workflow.log`,
  `runId = id`. The `runId` bloom filter prunes other runs' objects.
- **Latest run of a document** (`GET …/runs?documentId=`): the list read with
  `documentId`, `limit` 1.
- **Schedule overlap guard** (`runScheduledWorkflow`): asks `activeRuns` only.
  After a restart nothing is in flight, so the stored state doesn't matter.

## Result and resume artifacts

`workflowArtifactKey(runId, kind)` objects live outside the series and would
still be kept forever. They move into the run's window:
`series/{seriesId}/{window}/a-{runId}-{kind}.json`.

- Prune deletes everything under an expired window prefix, so artifacts expire
  with their run.
- Window listings only keep `*.tsc.br`, so reads and compaction never see them.
- `#series/store.ts` gets `writeSeriesAttachment` / `readSeriesAttachment`
  (series name, ts, file name). Jobs never build series keys themselves.
- `hasResult` replaces the stored `resultArtifactPath`; the key is derived.

## Realtime

- `workflowRun(runId)` and `workflowRuns` topics stay and are emitted from
  `runStore` as now.
- The shared series fires `series(workflow-runs)` on every log flush of every
  run. The run view refetches its logs on `workflowRun(runId)` instead of the
  series topic.

## Save as document (optional)

An action on a finished run that creates an ordinary document: status, inputs,
error, result and log lines as a snapshot. It is not linked back to the run
and does not stop the run from expiring. It's a separate step, after the move.

## Removed

- `workflowRunDocumentType`, its allowed-children entries, the 404 in
  `routes/spaces/document.ts`, the tree filtering.
- `runProperty`, `runProperties`, `deserializeRun`, `writeRunToDocument`,
  `persistRunToDocument`, `persistNow`, `listStoredRuns` and its cursor codec,
  `recoverSpace`, `ensureSpaceRecovered`, `getLatestRunIdForDoc`.
- `workflowRunSeriesName` (per-run series).
- `VEKTOR_WORKFLOW_LOG_RETENTION_DAYS`.

## Order of work

1. `run` id prefix, `workflow-runs` declaration, point types.
2. `runStore`: write create/terminal snapshots and logs to the series; keep
   `activeRuns`; delete the document persistence.
3. Series attachments; move result/resume artifacts onto them.
4. Reads: `getRunForRead`, `listRuns`, derived status, log reads; the overlap
   guard on `activeRuns`.
5. Routes (`workflow-runs.ts`, `workflow-run.ts`): space-level ACL, response
   shape unchanged apart from id format.
6. Clients: `WorkflowView`, `JobsSettings`, `WorkflowRunButton`, CLI and agent
   tool log reads (`readWorkflowRunLogLines` takes a run, reads the shared
   series), dedupe across pages.
7. Migration `7`: delete `workflow-run` documents and their per-run series
   (rows and objects).
8. Remove the dead code and setting.
9. Save as document.

## Tests

Integration, real storage:

- A run's list entry and run read show `pending` → terminal, with every log line
  visible once the terminal status is.
- A run whose process died reads as failed (recovery error) without any write.
- Paging the run list across a create/terminal boundary yields each run once.
- `documentId` and `sourceExtensionId` filters return full pages.
- Artifacts and points are gone after retention prune; nothing about the run
  is left in SQLite.
- Resume from a failed run replays cached steps.
- The scheduled overlap guard skips while a run is active.
